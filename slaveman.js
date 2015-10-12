/*
    This module manages the slave connections. It handles the creation and the
    breakdown of all connectins. It exposes a simple and easy to use interface.

    @exported(updateAddress).desc:     Set the address to be used for the slave ID.
    @exported(updateAddress).type:     function reference
    @exported(sendjson).desc:          Send a message to the specified slave.
    @exported(sendjson).type:          function reference
*/
var ws = require('ws');

var slaveman = function () {
	this.sidtoaddr = {};
	this.conn = {};
	this.queue = [];
	this.connecting = {};
	this.requid = 100;
	this.replycb = {};

  var self = this;

  /*
    This provides timeout support for queued messages.
  */
  setTimeout(function () {
    var ct = (new Date()).getTime();
    for (var x = 0; x < self.queue.length; ++x) {
      var qitem = self.queue[x];

      if (ct - qitem.since > qitem.timeout) {
        qitem.cb(null, false);
        self.queue.splice(x, 1);
        --x;
      }
    }
  }, 5000);

  return this;
};

module.exports = slaveman;

slaveman.prototype.updateAddress = function (sid, address) {
	this.sidtoaddr[sid] = address;
};

// TODO: consider linked list instead of queue if performance is needed

slaveman.prototype.process_queue = function () {
	var self = this;

	for (var x = 0; x < this.queue.length; ++x) {
		var qitem = this.queue[x];

		if (qitem.address in this.connecting) {
			continue;
		}

		if (qitem.address in this.conn) {
			qitem.msg.__rid = this.requid++;
			this.replycb[qitem.msg.__rid] = qitem.cb;
			this.conn[qitem.address].send(JSON.stringify(qitem.msg));
      /*
        Remove the queue item and adjust our index so we do
        not skip the next item after this operation.
      */
      this.queue.splice(x, 1);
      --x;
			continue;
		}

		function connect(address, cb) {
			self.connecting[address] = true;

			var client = new ws(address);

			client.__address = address;

			client.on('open', function () {
				delete self.connecting[address];
				self.conn[address] = client;
				client.on('error', function () {
					/*
						TODO: See if a message can be sent, then have an error
						      and never be delivered. If so then we need to find
						      a way to detect this and resend the message on a fresh
						      connection?
					*/
					delete self.conn[address];
				});
				self.process_queue();
			});

			client.on('message', function (msg) {
				msg = JSON.parse(msg);

				if (msg.__rid) {
					/*
						(1) call if valid
						(2) remove to prevent memory leak
					*/
					var rcb = self.replycb[msg.__rid];
					delete self.replycb[msg.__rid];
					if (rcb) {
						rcb(msg, true);
					}
				}
			});

			client.on('error', function () {
				if (cb) {
					cb(null, false);
				}
				console.log('slaveman', 'error sending message to ' + this.__address);
			});
		}

		console.log('slaveman', 'connecting to ' + qitem.address + ' [has callback? ' + (qitem.cb ? 'yes' : 'no') + ']');
		connect(qitem.address, qitem.cb);
	}
}

slaveman.prototype.sendjson = function (sid, obj, cb, timeout) {
	/*
		(1) Do we have a connection existing already?
		(2) Is the connection good?
	*/
	var address = this.sidtoaddr[sid];
	var conn = this.conn[address];

	this.queue.push({
		address:        address,
		sid:            sid,
		msg:            obj,
		cb:             cb,
    timeout:        timeout,
    since:          (new Date()).getTime(),
	});
	this.process_queue();
};
