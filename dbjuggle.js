var fs = require('fs');


/*
  
  

*/


var sqlite3;
try {
    sqlite3 = require('sqlite3');
} catch (err) {
    sqlite3 = null;
}

var mysql;
try {
    mysql = require('mysql');
} catch (err) {
    mysql = null;
}

dbjuggle = {};

module.exports = dbjuggle;

dbjuggle.log = function (msg, sync) {
    if (sync) {
        fs.appendFileSync('dbjuggle.log', msg + '\n');
    } else {
        fs.appendFile('dbjuggle.log', msg + '\n');
    }
};

dbjuggle.DatabaseGeneric = function (dbcfg, dbspec) {
    this.dbcfg = dbcfg;
    this.dbspec = dbspec;
    this.pending = [];
    this.pending_lock = false;
    this.refcnt = 1;
    this.outstandingtrans = [];

    this.remoutstandingtrans = function (trans) {
        var ndx = this.outstandingtrans.indexOf(trans);
        if (ndx > - 1) {
            this.outstandingtrans.splice(ndx, 1);
        }
    }

    this.dup = function (cb) {
        dbjuggle.opendatabase(dbcfg, cb);
    }

    this.acquire = function () {
        ++this.refcnt;
        //dbjuggle.log('acquire', this.refcnt);
    };

    this.release_all = function () {
        this.refcnt = 1;
        this.release();
    }

    this.release = function () {
        --this.refcnt;
        //dbjuggle.log('release', this.refcnt);
        if (this.refcnt > 0) {
            /*
                Only release once the reference count
                has reached zero.
            */
            return;
        }
        /*
            Depending on the implementation this may cause
            the connection to be recycled back into a pool
            such as MySQL for an example; depending on the
            configuration specified.
        */
        this.dbspec.release(this);
        /*
            We need to render this object unsable. Hopefully
            the following code does the trick. That way if
            we forget we might be able to read a member of
            the object, but we surely will not be able to
            call any methods and corrupt/screw up the database
            connection incase it is recycled in a pool.
        */
        function __error_out() {
            throw new Error('You can not use a database connection after it has been released.');
        }

        for (var k in this) {
            if (typeof(this[k]) == 'function') {
                this[k] = __error_out;
            }
        }

        this.release = function () {
            dbjuggle.log('WARNING: double release on database');
        }

        --dbjuggle.opendatabase.outstanding;
        dbjuggle.log('dbjuggle.opendatabase.outstanding=' + dbjuggle.opendatabase.outstanding);
    };

    this.process_pending = function (clearlock) {
        if (clearlock) {
            // We have finished a transaction, and
            // we need to clear the lock and execute
            // any other pending transactions.
            this.pending_lock = false;
        }

        if (this.pending_lock) {
            // We are in the middle of executing
            // another transaction.
            return;
        }

        if (this.pending.length < 1) {
            // There is nothing left that
            // is current pending.
            return;
        }

        this.pending_lock = true;
        var next = this.pending.pop();
        next.__execute(next.cb);
    };

    var self = this;

    this.transaction = function () {
        var r = {
            dbi:      self,
            stmts:    [],
            results:  {},
            done:     false,
            executed: false,
            pending:  0,
            commited: false,

            locktable: function (table) {
                if (this.executed) {
                    throw new Error('This statement has already been executed');
                }
                this.dbi.dbspec.locktable(this, table);
            },
            add: function (sqlstmt, params, key) {
                if (this.executed) {
                    throw new Error('This statement has already been executed');
                }
                this.stmts.push({
                    sqlstmt:    sqlstmt,
                    params:     params,
                    resultkey:  key
                });
            },
            execute: function (cb, highpriority) {
                if (this.executed) {
                    throw new Error('This statement has already been executed');
                }
                // (1) Store the callback.
                // (2) Increment the database instance reference count.
                //     (We will release it once the callback returns)
                // (2) Add us to pending.
                // (3) Process the pending queue.
                this.executed = true;
                this.cb = cb;
                this.dbi.acquire();
                if (highpriority) {
                    /*
                        This is commonly used when we have taken some table
                        locks and need to do another operation with out releasing
                        these locks. So the transaction is entered as a high
                        priority which means it shall run next on this connection.
                    */
                    this.dbi.pending.splice(0, 0, this);
                } else {
                    this.dbi.pending.push(this);
                }
                this.dbi.process_pending(false);
            },
            __docb: function (cb) {
                this.done = false;
                if (cb == true || cb == undefined) {
                    // If no callback specified, OR the callback
                    // was set to true, then auto-commit the
                    // transaction.
                    var r = this.commit();
                    this.dbi.release();
                    return r;
                }
                try {
                    var r = cb(this);
                } catch (err) {
                    /*
                        We do not want to handle the error
                        here, but we would like to decrement
                        the reference count we incremented
                        when this transaction was scheduled
                        for execution.
                    */
                    dbjuggle.log('WARNING: database execution callback error; decrementing reference');
                    this.dbi.release();
                    throw err;
                }
                // If callback used we only commit if it returned
                // true and it has not already called commit or
                // rollback.
                if (r && !this.done) {
                    this.commit();
                }
                if (!r && !this.done) {
                    this.rollback();
                }
                this.dbi.release();
                return this.commited;
            },
            __execute: function (cb) {
                var self = this;
                this.dbi.dbspec.transaction(this, null, function () {
                    self.pending = self.stmts.length;
                    for (var x = 0; x < self.stmts.length; ++x) {
                        var stmt = self.stmts[x];
                        // I have opted to using ? provided by sqlite3,
                        // and will just emulate that for any other
                        // database.
                        //
                        //if (stmt.params != undefined) {
                        //    for (var k in stmt.params) {
                        //        var re = new RegExp('{' + k + '}', 'g');
                        //        stmt = stmt.replace(re);
                        //    }
                        //}
                        self.dbi.dbspec.execute(self, stmt.sqlstmt, stmt.params, {
                            f: function (data, err, rows) {
                                self.results[data] = {
                                    err:    err,
                                    rows:   rows
                                };
                                --self.pending;
                                if (self.pending < 1) {
                                    self.__docb(self.cb);
                                }
                            },
                            data: self.stmts[x].resultkey
                        });
                    }

                    if (self.pending == 0) {
                        // If we could start another transaction..
                        // self.dbi.process_pending();
                        self.__docb(cb);
                    }
                });
            },
            rollback: function (cb) {
                if (this.done) {
                    return false;
                }
                var self = this;
                this.done = true;
                this.dbi.remoutstandingtrans(this);
                this.dbi.dbspec.rollback(this, function (err) {
                  self.commited = false;
                  self.dbi.process_pending(true);
                  if (cb) {
                    cb(err);          
                  }
                });
            },
            commit: function(cb) {
                if (this.done) {
                    return false;
                }
                var self = this;
                this.done = true;
                this.dbi.remoutstandingtrans(this);
                this.dbi.dbspec.commit(this, function (err) {
                  self.commited = true;
                  self.dbi.process_pending(true);
                  if (cb) {
                    cb(err);
                  }
                });
            },
        };

        self.outstandingtrans.push(r);
        return r;
    };

    return this;
}

dbjuggle.opendatabase = function (db, cb) {
    switch (db.type) {
        case 'mysql':
            if (mysql == null) {
                throw new Error('The `mysql` node module could not be loaded. Is it installed? `npm install mysql`');
            }
            var dbi = new dbjuggle.DatabaseGeneric(
                db,
                {
                    release: function (self) {
                        if (!self.done) {
                            /*
                                There is an on-going transaction, and there
                                was never a specified commit or rollback, so
                                let us be safe and just issue a rollback.
                            */
                            self.instance.query('ROLLBACK');
                            self.done = true;
                        }
                        self.instance.release();
                        self.instance = undefined;
                    },
                    locktable: function (self, name, writelock) {
                        self.__mysql_ttl = self.__mysql_ttl || [];
                        self.__mysql_ttl.push({
                            name:         name,
                            writelock:    (writelock ? true : false)
                        });
                    },
                    execute: function (self, stmt, params, cb) {
                        try {
                            self.dbi.instance.query(stmt, params, function (error, results, fields) {
                                if (error) {
                                    dbjuggle.log('SQL error', true);
                                    dbjuggle.log(error, true);
                                    dbjuggle.log(stmt, true);
                                    dbjuggle.log(params, true);
                                    /*
                                        (see below for note about rollback)
                                    */
                                    self.rollback();
                                    throw new Error('SQL statement error.');
                                }
                                cb.f(cb.data, error, results);
                            });
                            //dbjuggle.log(stmt, params);
                        } catch (err) {
                            dbjuggle.log('SQL error');
                            dbjuggle.log(err);
                            dbjuggle.log(stmt);
                            dbjuggle.log(params);
                            dbjuggle.log(cb);
                            /*
                                Rollback the transaction, because this can be caught
                                and the application may reuse the connection for another
                                transaction and we do not want this accidentally commited.
                            */
                            self.rollback();
                            throw err;
                        }
                    },
                    transaction: function (self, data, cb) {
                        /*
                            A nice effect here is we avoid the problem of issuing a second
                            LOCK TABLES which would be an implicit COMMIT. So our model here
                            keeps that surprise from happening by grabbing all locks at the
                            begging and releasing them at the end.
                        */
                        /* I am assuming InnoDB which needs this to happen to prevent
                           potential deadlocks because of the way it and MySQL work.

                           Maybe we could detect the storage engine?
                        */
                        self.dbi.instance.query('SET autocommit=0');
                        if (self.__mysql_ttl != undefined && self.__mysql_ttl.length > 0) {
                            var parts = []
                            for (var x = 0; x < self.__mysql_ttl.length; ++x) {
                                parts.push(self.__mysql_ttl[x].name + (self.__mysql_ttl[x].writelock ? ' WRITE' : 'READ'));
                            }
                            self.dbi.instance.query('LOCK TABLES ' + parts.join(', '));
                        }
                        self.dbi.instance.query('START TRANSACTION');
                        cb(data);

                        /* Not really sure if I should even do this. Consdering technicaly
                           we own this connection unless the caller wants to open their
                           own.
                        */
                        self.dbi.instance.query('SET autocommit=1');
                    },
                    rollback: function (self, cb) {
                        /*
                            Make sure that we unlock all locks we held.
                        */
                        if (self.__mysql_ttl != undefined && self.__mysql_ttl.length > 0) {
                            self.dbi.instance.query('UNLOCK TABLES');
                        }
                        self.dbi.instance.rollback(cb);
                    },
                    commit: function (self, cb) {
                        /*
                            Make sure that we unlock all locks we held.
                        */
                        if (self.__mysql_ttl != undefined && self.__mysql_ttl.length > 0) {
                            self.dbi.instance.query('UNLOCK TABLES');
                        }
                        self.dbi.instance.commit(cb);
                    }
                }
            );
            dbi.db = db;
            /*
                Here I create a pool for each unique database that we will
                connect to. This prevents us from overloading the database
                with too many connections, while still providing as many as
                possible for hungry clients. The MySQL module happened to
                have the pooling built-in so I decided to use what it provided.
            */
            dbjuggle.opendatabase.mysql_pools = dbjuggle.opendatabase.mysql_pools || {};
            /*
               TODO:    make this support more friendly and safe.. get rid of \x06
               WARNING: potential problem
            */
            var dbid = db.host + '\x06' + db.user + '\x06' + db.dbname;
            if (!dbjuggle.opendatabase.mysql_pools[dbid]) {
                dbjuggle.log('created mysql connection pool for ' + db.host + ':' + db.user + ':' + db.dbname);
                dbjuggle.opendatabase.mysql_pools[dbid] = mysql.createPool({
                    host:     db.host,
                    user:     db.user,
                    password: db.pass,
                    database: db.dbname
                });
            }

            dbjuggle.opendatabase.mysql_pools[dbid].getConnection(function (err, connection) {
                dbi.instance = connection;
                if (dbjuggle.opendatabase.outstanding == undefined) {
                    dbjuggle.opendatabase.outstanding = 0;
                }
                ++dbjuggle.opendatabase.outstanding;
                dbjuggle.log('got mysql connection for ' + db.host + ':' + db.user + ':' + db.dbname);
                cb(err, dbi);
                dbi.release();
            });
            /*
                This is the old method when not using a pool.
                dbi.instance.connect();
            */
            return;
        case 'sqlite3':
            if (sqlite3 == null) {
                throw new Error('The `sqlite3` node module could not be loaded. Is it installed? `npm install sqlite3`');
            }
            throw new Error('SQLITE3 not fully implemented');
            var dbi = new dbjuggle.DatabaseGeneric(
                db,
                {
                    locktable: function (self, name) {
                        self.__sqlite3_begin = 'BEGIN EXCLUSIVE TRANSACTION';
                    },
                    execute: function (self, stmt, params, cb) {
                        self.dbi.instance.all(stmt, params, function (err, rows) {
                            cb.f(cb.data, err, rows);
                        });
                    },
                    transaction: function (self, data, cb) {
                        self.dbi.instance.serialize(function () {
                            if (self.__sqlite3_begin) {
                                self.dbi.instance.run(self.__sqlite3_begin);
                            } else {
                                self.dbi.instance.run('BEGIN TRANSACTION');
                            }
                            cb(data);
                        });
                    },
                    rollback: function (self) {
                        self.dbi.instance.run('ROLLBACK');
                    },
                    commit: function (self) {
                        self.dbi.instance.run('COMMIT');
                    }

                }
            );

            //cb(null, new sqlite3.Database(db.path));
            throw new Error('SQLITE3 MISSING SMALL STUB IMPLEMENTATION');
        default:
            throw new Error('The database type was not supported.');
    }
}
