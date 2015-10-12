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
var common = require('./common.js');

var hurt = {
	server: {},
	util: {}
};


/*
  This will get the nearest leaf.
*/
hurt.util.getPatchTreeLeaf = function(state, zid, x, y, z, mxyz, cb) {
  var patches = common.BuildPotentialPatchListFromXYZ(x, y, z, mxyz);
  
  var tmp = [];

  for (var x = 0; x < patches.length; ++x) {
    tmp.push(patches[x][0]);
  }

  var trans = state.db.transaction();
  trans.add(
    'SELECT patch_host_id FROM patch_tree WHERE zid = ? AND patch IN (' + tmp.join(',') + ') ORDER BY patch',
     [zid], 
     'r'
  );

  trans.execute(function (t) {
    var rows = t.results.r.rows;
    for (var x = 0; x < rows.length; ++x) {
      if (rows[x].patch_host_id > -1) {
        cb(rows[x].patch_host_id);
        return;
      }
    }
    cb(-1);
  });
};

/*
  This will update the patch tree with a leaf.
*/
hurt.util.setPatchTreeLeaf = function(state, zid, x, y, z, mxyz, patch_host_id, cb) {
  var patches = common.BuildPotentialPatchListFromXYZ(x, y, z, mxyz);

  var ct = (new Date()).getTime() / 1000;

  function doit(x) {
    var cur = patches[x];
    var leaf;
    if (x == patches.length - 1) {
      leaf = patch_host_id;
    } else {
      leaf = -1;
    }
    var trans = state.db.transaction();
    trans.add(
      'INSERT INTO patch_tree (zid, patch, up, last_update, patch_host_id) VALUES (?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE up = up | ?, last_update = ?, patch_host_id = ?',
      [zid, cur[0], cur[1], ct, leaf, cur[1], ct, leaf],
      'r'
    );
    trans.execute(function (t) {
      if (x + 1 >= patches.length) {
        cb();
        return;
      }
      doit(x + 1);
    });
  }
  doit(0);
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
hurt.util.checkPatchHosted = function (state, zid, x, y, z, mxyz, cb) {
  function restart() {
    hurt.util.ensurePatchHosted(state, zid, x, y, z, mxyz, cb);
  }


  //hurt.util.getPatchTreeLeaf = function(state, zid, x, y, z, mxyz, cb) 

  hurt.util.getPatchTreeLeaf(state, zid, x, y, z, mxyz, function (patch_host_id) {
    if (patch_host_id == -1) {
      var trans = state.db.transaction();
      trans.add(
        'SELECT address, lastalive FROM patch_host WHERE patch_host_id = ?', 
        [patch_host_id],
        'r'
      );
      trans.execute(function (t) {
        var row = t.results.r.rows[0];
        var ct = (new Date()).getTime();

        if (row) {
          cb(row.address, ct - row.lastalive);
        } else {
          cb(null, 999999, false);
      });
    }  
  });
}

function hurt.util.ensureHostedByPatch(state, zid, x, y, z, mxyz, cb) {
  hurt.util.checkPatchHosted(state, zid, x, y, z, mxyz, function (address, delta) {
    if (delta > 60 * 4) {
      /* Rehost it. */
      
      return;
    }
  });
};

function hurt.util.startPatchHosting(state, zid, patches, cb) {
  var trans = state.db.transaction();
  trans.add('SELECT up, locked, address, sid FROM slaves', [], 'r');
  trans.execute(function (t) {
    var rows = t.results.r.rows;
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
            subject:        'host-zone-request',
            zid:            zid,
            patch_host_id:  patch_host_id,
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

	trans.add('SELECT state FROM zones WHERE zid = ?', [zid], 'a');
	trans.execute(function (t) {
		var rows = t.results.a.rows;
    
		if (rows.length < 1) {
      console.log('[index-server] creating zone from scratch', zid);
			var trans = state.db.transaction();
			trans.add('INSERT INTO zones (zid, state) VALUES (?, ?)', [zid, zstate], 'r');
			/*
				Execute as a high priority so we do not have our lock released.
			*/
			trans.execute(function (t) {
        if (t.results.r.err) {
          console.log('[index-server] Opps.. zone already creating.. repeating ensureZoneCreated');
          hurt.util.ensureZoneCreated(state, zid, zstate, cb);
        }
        console.log('zone created', zstate);
				trans.commit();
        cb(zstate);
			}, true);
      return;
		}

		cb(rows[0].state);
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

      ws.on('error', function (er) {
        console.log('client dropped by error', state.clients[this.uid]);
        delete state.clients[this.uid];
      });

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
						var __disjoint_work1 = function (uid, mid, zid, mstate) {
							var __disjoint_phase1 = function (mstate, zstate) {
                /*
                  We need to ensure that the zone is currently hosted. If it
                  is not hosted then we need to start an instance of the zone
                  and wait until it is ready for connections. Then we need to
                  direct the client to connect to this zone instance.
                */
                mstate = JSON.parse(mstate);
                zstate = JSON.parse(zstate);

                console.log('@@@zstate', zstate, zstate.mxyz);
                hurt.util.ensurePatchHosted(
                  state, zid,
                  mstate.x, mstate.y, mstate.z,
                  zstate.mxyz,
                  function (isHosted, address) 
                {
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
							zstate = hurt.util.ensureZoneCreated(state, zid,
								/*
									We can set the initial properties
									of the zone here, but if we do not
									the it will happen in the slave or
									zonehost later.
								*/
                {
                  mxyz:     2883584000,  /* 100 cubic miles (see common.js) */
                },
							  function (zstate) {
                  /*
                    We also have the zstate that was either from above if it
                    was created, or what the actual state was. We need the
                    `mxyz` parameter in order to locate the zone-host that is
                    hosting the patch the machine is located on.
                  */
                console.log('[index-server] zone creaton ensured');
								__disjoint_phase1(mstate, zstate);
							});
              /* [control released back to caller] */
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

									__disjoint_work1(uid, mid, 0, mstate);
								});

								//ws.sendjson({
								//	subject:    'login-rejected',
								//	desc:   'The user was not found'
								//});
								return;
							}

							var uid = result[0].uid;
							var mid = result[0].mid; 
							console.log('user and machine existing', uid, mid, result);

              /* Fetch machine state */
              var trans = db.transaction();
              trans.add('SELECT state, zid FROM machines WHERE mid = ?', [mid], 'r');
              trans.execute(function (t) {
                if (t.results.r.rows.length < 1) {
                  ws.sendjson({
                    subject:    'login-rejected',
                    desc:       'Internal Error: The machine could not be located.',
                  });
                  return;
                }
  							__disjoint_work1(uid, mid, t.results.r.rows[0].zid, t.results.r.rows[0].state);
              });
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
