/*
	$
*/

var http = require('http');
var fs = require('fs');
var crypto = require('crypto');
//var Canvas = require('canvas');
var ws = require('ws');
var spawn = require('child_process').spawn;
var dbjuggle = require('./dbjuggle.js');

var httphandler = require('./httphandler.js');
var Slave = require('./slave.js');
var slaveman = require('./slaveman.js');

var hurt = {
	server: {},
	util: {}
};

/*
	This will ensure that the zone is hosted and then execute the callback.

	@param(state):        state structure
	@param(state).note:   Currently uses `db` filed to get a transaction.
	@param(zid):          zone identifier
	@param(zid).type:     numeric
	@param(cb):           callback
	@param(cb).type:      function reference
	@param(cb).note:      This may be executed sync or async.
*/
hurt.util.ensureZoneHosted = function (state, zid, cb) {
	var trans = state.db.transaction();

	/*
		This is going to lock the entire table in MySQL, which is desirable in our
		usage, however something better is desired.
	*/
	trans.locktable('zone_host');
	trans.add('SELECT address, lastalive, up FROM zone_host WHERE zid = ?', [zid], 'a');
	trans.execute(function (t) {
		var rows = t.results.a.rows;
		/*
			Beware, the table zone_host is STILL LOCKED.
		*/

		/*
			This zone has problems. It is currently locked, but for now
			just let the zone handle the connection rejection.
		*/

		/*
			We need to bring this zone online. To do so we need to select a slave
			that will host the zone. Hopefully some load balancing can be added
			here, but for now we just select the first slave we have.
		*/
		if (rows.length < 1 || rows[0].up == 0) {
			var trans = state.db.transaction();
			trans.add('SELECT sid, address, up, locked FROM slaves', [], 'a');
			trans.execute(function (t) {
				var rows = t.results.a.rows;
				console.log('looking for slave to host zone ' + zid);
				console.log(rows);
				function __find_slave(x) {
					for (; x < rows.length; ++x) {
						if (rows[x].up[0] == 1 && rows[x].locked[0] == 0) {
							/*
								We need to request that the slave host this zone,
								and also get validation that the zone is hosted.
							*/
							hurt.slaveman.updateAddress(rows[x].sid, rows[x].address);
							hurt.slaveman.sendjson(rows[x].sid, {
								subject:      'host-zone-request',
								zid:      zid
							}, null, function (msg) {
								if (msg.success) {
									console.log('zone is hosted');
									cb(true, rows[x].address);
								} else {
									__find_slave(x + 1);
								}
							});
							return;
						}
					}
					/*
						We exhausted all slaves and none could host the zone.
					*/
					console.log('slaves exhausted looking for host for zone ' + zid);
					cb(false);
				}

				__find_slave(0);
			});
			return;
		}

		/*
			At this point the zone is hosted. We can return and the lock
			will be released. I will rollback because I know of nothing
			that I need to have commit at this point.
		*/
		t.rollback();
		cb(true, rows[0].address);
	});
};

hurt.util.ensureZoneCreated = function (state, zid, zstate, cb) {
	var trans = state.db.transaction();

	/*
		If this happens it was because this is *like* dead code. It just
		gets called incase we ever do want to give it a state here on the
		index server.
	*/
	if (!zstate) {
		zstate = {
		};
	}

	zstate = JSON.stringify(zstate);

	trans.locktable('zones');
	trans.add('SELECT state FROM zones WHERE zid = ?', [zid], 'a');
	trans.execute(function (t) {
		var rows = t.results.a.rows;

		if (rows.length < 0) {
			var trans = state.db.transaction();
			trans.locktable('zones');
			trans.add('INSERT INTO zones (zid, state) VALUES (?, ?)', [zid, zstate]);
			/*
				Execute as a high priority so we do not have our lock released.
			*/
			trans.execute(function () {
				trans.commit();
			}, true);
		}

		cb();
	});
};

hurt.masterindexstart = function (cfg) {
	var state = {
		cfg: 		cfg,
		uid:        100
	};


	/*
		This handles messages from slaves generally in response
		to requests that we make which arrive asynchronously from
		when we send them.
	*/
	hurt.slaveman = new slaveman();

	/*
		This handles non-web socket requests.
	*/
	http.createServer(function (req, res) {
	    httphandler.handlerL0(state, req, res);
	}).listen(45600);

	/*
		We can expect connections from anything over web socket here.
	*/
	var WebSocketServer = ws.Server;
	var wss = new WebSocketServer({
		port: 45601
	});

	state.clients = {};

	dbjuggle.opendatabase(state.cfg.db, function (err, db) {
		/*
			This will make sure that our DB does not get
			released when this function exits. We are now
			responsible for manual release.
		*/
		state.db = db;
		db.acquire();

		wss.on('connection', function (ws) {
			ws.uid = state.uid++;
			state.clients[ws.uid] = ws;

			console.log('new socket as ' + ws.uid);

			ws.sendjson = function (obj) {
				console.log('sending message on socket to ' + ws.uid);
				this.send(JSON.stringify(obj));
			};

			ws.on('message', function (msg) {
				try {
					msg = JSON.parse(msg);
				} catch (err) {
					/*
						TODO: add code to report error to client and server log
					*/
					return;
				}

				switch (msg.subject) {
					case 'login':
						var user = msg.user;
						var passhash = msg.passhash;
						/*
							Validate their login then try to get them linked
							to their machine and the zone server needed. We
							might even need to make a new machine instance if
							we can not find one.
						*/
						var __disjoint_work1 = function (uid, mid) {
							var __disjoint_phase1 = function () {
								console.log('getting machine ' + mid + ' for user ' + uid);
								var trans = db.transaction();
								trans.add('SELECT zid FROM machines WHERE mid = ?', [mid], 'a');
								trans.execute(function (t) {
									var result = t.results.a.rows;

									if (result.length < 1) {
										ws.sendjson({
											subject: 'login-rejected',
											desc:    'Oddly.. there is supposed to be a machine that we have no record of..'
										});
										return;
									}

									console.log('@@', result.length);

									var zid = result[0].zid;

									/*
										We need to ensure that the zone is currently hosted. If it
										is not hosted then we need to start an instance of the zone
										and wait until it is ready for connections. Then we need to
										direct the client to connect to this zone instance.
									*/
									hurt.util.ensureZoneHosted(state, zid, function (isHosted, address) {
										if (isHosted) {
											console.log('ACCEPTED');
											ws.sendjson({
												subject:  'login-accepted',
												uid:      uid,
												mid:      mid,
											});
											ws.sendjson({
												subject:  'zone-change',
												zid:      zid,
												address:  address
											});
											return;
										}

										console.log('REJECTED');
										ws.sendjson({
											subject: 'login-rejected',
											desc:    'Unable to get zone hosted your avatar machine is located in.'
										});
									});
								});
							}

							/*
								Get the zone that the machine is in. If no
								zone can be found then create one and in
								just a moment we will try to host it.

								TODO: set machine ID here??
								Also make sure machine ID is set for the user.
							*/
							//var trans = db.transaction();
							//trans.add('UPDATE users SET mid = ?', [mid]);
							//trans.execute(function (t) {
								hurt.util.ensureZoneCreated(state, 0,
									/*
										We can set the initial properties
										of the zone here, but if we do not
										the it will happen in the slave or
										zonehost later.
									*/
									null
								, function () {
									__disjoint_phase1();
								});
							//});
							//__disjoint_phase1();
						}
						/*
							TODO: add password hash validation

							I have left this open for testing.
						*/
						var trans = db.transaction();
						trans.add('SELECT uid, mid FROM users WHERE user = ?', [user], 'a');
						trans.execute(function (t) {
							var result = t.results.a.rows;

							if (result.length < 1) {
								/*
									For testing allow creation of any user.
								*/
								var mstate = {
									hull_integrity:    1.0,
									energy_stored:     100.0,
									x:                 0.0,
									y:                 0.0,
									z:           	   0.0
								};

								var trans = db.transaction();
								trans.add('INSERT INTO machines (zid, state, lastupdate) VALUES (?, ?, ?);',
									[0, JSON.stringify(mstate), 0]
								);
								trans.add('SELECT LAST_INSERT_ID() AS mid;', [], 'midres');
								trans.add('INSERT INTO users (mid, user, hash, smsphone) VALUES (LAST_INSERT_ID(), ?, ?, ?);',
									[user, '<testing>', '<none>']
								);
								trans.add('SELECT LAST_INSERT_ID() AS uid;', [], 'uidres');
								trans.execute(function (t) {
									var uid = t.results.uidres.rows[0].uid;
									var mid = t.results.midres.rows[0].mid;

									console.log('created user:' + user + ' as ' + uid + ' with machine ' + mid);

									t.commit();

									__disjoint_work1(uid, mid);
								});

								//ws.sendjson({
								//	subject:    'login-rejected',
								//	desc:   'The user was not found'
								//});
								return;
							}

							console.log('user and machine existing');
							var uid = result[0].uid;
							var mid = result[0].mid;
							__disjoint_work1(uid, mid);
						});
				}
			});

			ws.on('close', function () {
				delete state.clients[ws.uid];
			});
		});
	});
};

var db = {
    type:     'mysql',
    host:     'kmcg3413.net',
    dbname:   'hurt',
    user:     'hurt',
    pass:     'kxmj48dhxnzhsDxnMXJS3l'
};

hurt.masterindexstart({
	challenge_request_hash:     'o3p$IejdXm2n3#',
	challenge_response_hash:    'kxj39$kejdXMs',
	db: db
});

console.log('starting the slave');

var slave = new Slave({
	db:       db,
	port:     4500,
	sid:      210000,
	address:  'ws://localhost:4500'
});
