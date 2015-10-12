var Machine = require('./machine.js');

/*
    This holds all entities in the same interaction volume. I plan to
    use this abstraction in order to implement more performant divisioning
    of the entities under high load to reduce unnessary interaction checks.

    You simply add the entities using `addEntity`.

    Each entity is required to have the following members:
        id      number      unique identifier
        x       number      spatial coordinate on x-axis
        y       number      spatial coordinate on y-axis
        z       number      spatial coordinate on z-axis
        ivd     number      interaction volume distance
    Each entity is required to have the following unused members;
        __ev_children
        __ev_parent

    The `ivd` represents the distance in which this object can affect other
    objects also in this volume. It helps to optimize the volume. For example
    if one entity would like to gather a list of targets then anything further
    than the `ivd` is not returned as part of the enumeration.

    I expect there can exist more than one volume for the same zone therefore
    allowing further optimization at the expense of more overhead and memory.

*/
var EntityVolume = function () {
    this.entities = {};
    this.root = null;
    return this;
};

EntityVolume.prototype.addEntity = function (e) {
    this.entities[e.id] = e;

    // e.__ev_children = [];
    //e.__ev_parent = [];
    // 10^6 cycles - OK
    // 10^12 cycles - VERY BAD
    // 10^9 cycles - BAD

    //if (this.root == null) {
    //    this.root = e;
    //    return;
    //}
};

EntityVolume.prototype.getByID = function (id) {
    return this.entities[id];
};

EntityVolume.prototype.enumInteractionZones = function (cb) {
    var ecb = cb(100);

    for (var id in this.entities) {
        ecb[0](this.entities[id]);
    }

    ecb[1]();
};

var Map3 = function () {
    this.base = {};
};

Map3.prototype.put = function (a, b, c, d) {
    this.base[a] = this.base[a] || {};
    this.base[a][b] = this.base[a][b] || {};
    this.base[a][b][c] = d;
};

Map3.prototype.get = function (a, b, c) {
    if (this.base[a] == undefined) {
        return null;
    }

    if (this.base[a][b] == undefined) {
        return null;
    }

    return this.base[a][b][c];
};

var zonehost = function (slavestate, zid, patch_host_id, cb) {
    /*
        First we need to query the zone state and then
        determine if we can load it by doing some sanity
        checks if possible.

        TODO: sanity checks
    */
    var db = slavestate.db;

    var self = this;

    this.db = db;
    this.zid = zid;

    self.running = false;

    self.__pre_running_msg_queue = [];

    var trans = db.transaction();
    trans.add('SELECT state FROM zones WHERE zid = ?', [zid], 'a');
    trans.add('SELECT state FROM patch_host WHERE patch_host_id = ?', [patch_host_id], 'b');
    trans.execute(function (t) {
        var rows = t.results.a.rows;

        var zstate, pstate;

        if (t.results.b.rows.length > 0) {
          pstate = t.results.b.rows[0].state;
        } else {
          console.log('[zone-host] I could not find a patch-zone state; aborting.');
          cb(false);
          return;
        }

        if (rows.length > 0) {
          /*
            This is the last saved state for the zone.
          */
          zstate = JSON.parse(rows[0].state);
        } else {
          console.log('[zone-host] I could not find a zone state; aborting.');
          cb(false);
          return;
        }

        self.machines = new EntityVolume();

        self.zid = zid;

        self.slavestate = slavestate;
        self.zstate = zstate;
        self.state = pstate;

        self.chunks = new Map3();

        /*
            Go ahead and let our caller know that we are loaded. Even
            though we are not. I want this code like this.

            TODO: Consider saying we are okay later.
        */
        if (cb) {
            cb(true);
        } else {
            /*
                TODO: Might be helpful early in development.
            */
            console.log('zone-host', 'WARN', 'zone-host started with no callback');
        }

        /*
            Get machines in this zone and load them.
        */
        function loadAllMachines(cb) {
            console.log('zone-host is loading all machines');
            var trans = db.transaction();
            trans.add('SELECT mid, state FROM machines WHERE zid = ?', [zid], 'a');
            trans.execute(function (t) {
                var rows = t.results.a.rows;

                if (rows.length > 0) {
                    var x = 0;
                    function __disjoint_work1() {
                        while (x < rows.length) {
                            var mstate = JSON.parse(rows[x].state);
                            self.createMachineInstanceWithState(rows[x].mid, mstate, function () {
                                /*
                                    This might be a little intensive as everything is loaded
                                    up so let us delay it a little.
                                */
                                process.nextTick(__disjoint_work1);
                            });
                            ++x;
                            return;
                        }
                        cb();
                    }

                    __disjoint_work1();
                }
            });
        }

        loadAllMachines(function () {
            self.running = true;

            /*
                We might have recieved some messages and if so they were queued. Now
                that we are properly loaded we can easily handle them. Then we will
                destroy the queue since it should not be needed unless we become
                paused in the future.
            */
            console.log('zone-host has machines loaded and now processing delayed queue');
            for (var x = 0; x < self.__pre_running_msg_queue.length; ++x) {
                self.onMessage(self.__pre_running_msg_queue[x]);
            }

            delete self.__pre_running_msg_queue;

            /*
                The heart that beats for the zone.
            */
            setInterval(function () {
                self.tick();
            }, 1000);
        });
    });

    return this;
};

zonehost.prototype.tick = function () {
    if (!this.iid_left) {
        this.iid_left = {};
        this.iid_enter = {};
    }

    console.log('zone-host tick');

    var self = this;

    this.machines.enumInteractionZones(function (iid) {
        var position_updates = {};
        var initial_position_updates = {};
        var machines = [];
        return [function (mach) {
            if (mach.force[3] > 0.0) {
                mach.x += mach.force[0] * mach.force[3];
                mach.y += mach.force[0] * mach.force[3];
                mach.z += mach.force[0] * mach.force[3];
                mach.force[3] *= 0.2;
                if (mach.force[3] < 0.0) {
                    match.forc[3] = 0.0;
                }
                /*
                    Update anyone in this zone.
                */
                position_updates[mach.id] = [mach.id, mach.x, mach.y, mach.z];
            } else {
                initial_position_updates[mach.id] = [mach.id, mach.x, mach.y, mach.z];
            }

            if (iid != mach.iid) {
                /*
                    Let everyone in old interaction zone know that this
                    entity has left the interaction zone.
                */
                if (mach.iid) {
                    self.iid_left[mach.iid] = this.iid_left[mach.iid] || [];
                    self.iid_left[mach.iid].push(mach);
                }

                /*
                    Let everyone in the new interaction zone know that this
                    entity has entered the interaction zone.
                */
                self.iid_enter[iid] = self.iid_enter[iid] || [];
                self.iid_enter[iid].push(mach);
            }

            machines.push(mach);
        },
        function () {
            var entered = self.iid_enter;
            var left = self.iid_left;
            /*
                This is called before the next interaction zone is processed.
            */
            for (var x = 0; x < machines.length; ++x) {
                var mach = machines[x];
                var sock = mach.getAvatarSocket();

                for (var x = 0; x < entered.length; ++x) {
                    sock.sendjson({
                        subject:       'entity-entered',
                        eid:           entered[x].id
                    });
                }

                for (var x = 0; x < left.length; ++x) {
                    sock.sendjson({
                        subject:       'entity-left',
                        eid:           left[x].id
                    });
                }

                if (mach.last_iid != iid) {
                    for (var y = 0; y < initial_position_updates.length; ++y) {
                        sock.sendjson({
                            subject:        'entity-absolute-position-update',
                            eid:            initial_position_updates[y][0],
                            x:              initial_position_updates[y][1],
                            y:              initial_position_updates[y][2],
                            z:              initial_position_updates[y][3]
                        });
                    }
                    mach.hasAllUpdates = true;
                }

                for (var y = 0; y < position_updates.length; ++y) {
                    sock.sendjson({
                        subject:   'entity-absolute-position-update',
                        eid:       position_updates[y][0],
                        x:         position_updates[y][1],
                        y:         position_updates[y][2],
                        z:         position_updates[y][3]
                    });
                }

                mach.iid = iid;
            }
        }];
    });
};

zonehost.prototype.ensureChunksLoadedForMachine = function (machine, cb) {
    var mx = machine.x;
    var my = machine.y;
    var mz = machine.z;

    var bx = Math.floor(mx);
    var by = Math.floor(my);
    var bz = Math.floor(mz);
    var cx = Math.floor(bx / 16.0);
    var cy = Math.floor(by / 16.0);
    var cz = Math.floor(bz / 16.0);
    bx = bx - (cx * 16);
    by = by - (cy * 16);
    bz = bz - (cz * 16);

    /*
        Load the chunk the machine is on and also some chunks around it.
    */
    var ox = -1;
    var oy = -1;
    var oz = -1;

    var self = this;

    function __disjoint_work1 () {
        while (ox < 2) {
            while (oy < 2) {
                if (oz < 2) {
                    self.ensureChunkLoaded(cx + ox, cy + oy, cz + oz, function (chunk) {
                        __disjoint_work1();
                    });
                    ++oz;
                    return;
                }
                oz = 0;
                ++oy;
            }
            oy = 0;
            ++ox;
        }
        cb();
    }

    __disjoint_work1();
}

zonehost.prototype.ensureChunkLoaded = function (cx, cy, cz, cb) {
    var c = this.chunks.get(cx, cy, cz);

    /*
        At the moment for testing.

        Each block represented by an array of parameters.

        [0]:     0 - unknown block
                 1 - empty block
                 2 - solid block
    */

    if (!c) {
        /*
            Try getting chunk from the database
        */

        var self = this;

        var trans = this.db.transaction();
        trans.add('SELECT mime, data FROM chunks \
                   INNER JOIN resources \
                   ON chunks.rid = resources.rid WHERE chunks.zid = ? AND chunks.cx = ? AND chunks.cy = ? AND chunks.cz = ?',
                   [this.zid, cx, cy, cz],
                   'a'
        );
        trans.execute(function (t) {
            var results = t.results.a.rows;
            var c;

            /*
                Since we went async between checking the database and now
                let us check if it has already been loaded between that
                time. I would like some logic that sets something in local
                memory so we do not end up doing a redundant database query
                but it would require a waiting callback queue so I will wait
                until that time to improve performance.

                TODO: see above (performance improvement)
            */

            c = self.chunks.get(cx, cy, cz);
            if (c) {
                cb(c);
            }

            if (results.length < 1) {
                c = self.generateChunk(cx, cy, cz);
                console.log('generated chunk ' + [self.zid, cx, cy, cz].join(':'));
            } else {
                console.log('loaded chunk from storage ' + [self.zid, cx, cy, cz].join(':'));
                var buffer = results[0].data;
                if (results[0].mime != 'CHUNK_JSON_V001') {
                    throw new Error('The mime type for the chunk was unexpected.');
                }
                c = JSON.parse(buffer);
            }

            self.chunks.put(cx, cy, cz, x);
            cb(c);
        });
    }
};

zonehost.prototype.generateChunk = function(cx, cy, cz) {
    c = [];
    for (x = 0; x < 16; ++x) {
        for (y = 0; y < 16; ++y) {
            for (z = 0; z < 16; ++z) {
                if (z == 0) {
                    c.push([2]);
                } else {
                    c.push([1]);
                }
            }
        }
    }

    return c;
}

zonehost.prototype.readBlock = function (cx, cy, cz, bx, by, bz) {
    var c = this.chunks.get(cx, cy, cz);
    if (!c) {
        return null;
    }

    return c[bx * 16 * 16 + by * 16 + bz];
};

zonehost.prototype.updateAvatarForMachineWithInitialState = function (machine) {
};

zonehost.prototype.createMachineInstanceWithState = function (mid, mstate, cb) {
    var machine = new Machine(this, mstate, mid);
    this.machines.addEntity(machine);

    this.ensureChunksLoadedForMachine(machine, cb);
};

zonehost.prototype.createMachineInstanceWithMID = function (mid, cb) {
    /*
        We need to fetch the machine from the database. The database
        contains the machines state.
    */
    var self = this;
    var trans = this.slavestate.db.transaction();
    trans.add('SELECT zid, state, lastupdate FROM machines WHERE mid = ?', [mid], 'a');
    trans.execute(function (t) {
        var rows = t.results.a.rows;

        if (rows.length < 1) {
            cb(false, 'No machine found.');
            return;
        }

        if (rows[0].zid != self.state.zid) {
            cb(false, 'Zone ID mismatch.');
            return;
        }

        var mstate = JSON.parse(rows[0].state);
        self.createMachineInstanceWithState(mid, mstate, cb);
    });
};

zonehost.prototype.getMachineByID = function (mid) {
    return this.machines[mid];
};

zonehost.prototype.onMessage = function (msg) {
    if (!this.running) {
        this.__pre_running_msg_queue.push(msg);
    }

    switch (msg.subject) {
        case 'debug-control-move':
            var mid = ws.mid;
            if (!mid) {
                return;
            }

            this.machines.getByID(mid).forcePush(msg.force);
            return;
    };
};

module.exports = zonehost;
