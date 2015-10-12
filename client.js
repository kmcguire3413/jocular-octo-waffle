/*
  This is the Client object. You can create an instance of it
  and use it to connect to the server.
*/
function Client(cont) {
  this.build_interface(cont);
}

Client.prototype.connect = function () {
  var ws = new WebSocket('ws://localhost:45601');
  var self = this;
    
  this.ws = ws;

  this.set_status('Connecting to server..');

  // liberal minority skews the the view of the majority

  ws.onopen = function (event) {
    ws.sendjson({
      subject:   'login',
      user:      self.username.value,
      pass:      'nopassword',
    });
    self.set_status('Doing login to index server..');
  };

  ws.sendjson = function (obj) {
    this.send(JSON.stringify(obj));
  };

  /*
    This is a method created on Client. See Client documentation.
  */
  this.sendjson = function (obj) {
    this.ws.sendjson(obj);
  };

  /*
    This is a method created on Client. See Client documentation.
  */
  this.sendjsontozone = function (obj) {
    if (!this.ws.zws) {
      return false;
    }
    this.ws.zws.send(obj);
  };

  var my_uid;
  var my_mid;
  var my_zid;

  ws.onmessage = function (event) {
    var msg = JSON.parse(event.data);
    console.log('message-in', msg);
    switch (msg.subject) {
      /*
        This message means that the index server has changed our zone. We have to comply. It
        may have been an action that the client performed. This is normally sent the first
        time the client enters into the world.

        We simply disconnect from our current zone-host if any, and then connect to the new
        zone-host.
      */
      case 'zone-change':
        my_zid = msg.zid;
        self.set_status(['user-id:', my_uid, ' machine-id:', my_mid, ' zone-id:', my_zid, ' zone-address:', msg.address].join(''));

        console.log('instructed for zone-change to address', msg.address);
        var zws = new WebSocket(msg.address);

        self.set_status('Login ok on index server.. connecting to slave server hosting the zone..');

        if (ws.zws) {
          /*
            Drop the old connection and be nice and let the
            server know so it can go ahead and drop the connection
            without detecting it through the network transport
            layer.

            TODO: It is possible that the server may drop us before we
                  can send this.
          */
          ws.zws.sendjson({
            subject:     'logout'
          });
          ws.zws.close();
        }

        ws.zws = zws;

        var vis_entities = {};

        zws.sendjson = function (obj) {
          zws.send(JSON.stringify(obj));
        };

        zws.onopen = function (event) {
          self.set_status(['user-id:', my_uid, ' machine-id:', my_mid, ' zone-id:', my_zid, ' zone-address:', msg.address, ' INDEX-FEED-GOOD ZONE-FEED-GOOD'].join(''));
          console.log('got zone channel open');
          this.sendjson({
            subject:    'login',
            uid:        my_uid,
            mid:        my_mid,
            zid:        my_zid,
          });
        };

        zws.onmessage = function (event) {
          var msg = JSON.parse(event.data);
          console.log('msg', msg);
          switch (msg.subject) {
            /*
              This _may_ happen when we enter a portal for example, or the zone-host may use this to
              force us onto a different zone-host. We should comply with this command, because the
              zone-host is able to drop our connection after this message.
            */
            case 'zone-changed':
              // TODO: implement
              break;
            case 'entity-entered':
              vis_entities[msg.eid] = {
                label:     msg.label,
                x:         0.0,
                y:         0.0,
                z:         0.0
              };
              break;
            case 'entity-left':
              delete vis_entities[msg.eid];
              break;
            case 'entity-absolute-position-update':
              var eid = msg.eid;
              var e = vis_entities[eid];

              e.x = msg.x;
              e.y = msg.y;
              e.z = msg.z;

              var ctx = cv.getContext('2d');

              ctx.fillRect(msg.x, msg.y, 10, 10);
              ctx.fillText(msg.x, msg.y, e.label);
              break;
          }
        };

        zws.onerror = function (event) {
          self.set_status('Index login GOOD, but ERROR connecting to the zone host on slave at ' + msg.address);
        };
        break;
      case 'login-accepted':
        my_uid = msg.uid;
        my_mid = msg.mid;
        self.set_status(['user-id:', my_uid, ' machine-id:', my_mid, ' zone-id: <waiting>'].join(''));
        break;
    }
  }
};

Client.prototype.set_status = function(msg) {
  $(this.status).empty();
  $(this.status).append(msg); 
};

Client.prototype.build_interface = function (cont) {
  console.log('building client interface');
  
  var sub_cont = document.createElement('div');
  sub_cont.style['display'] = 'inline-block';
  sub_cont.style['background-color'] = '#777777';
  sub_cont.style['border'] = '3px dashed #999999';
  sub_cont.style['padding'] = '10px';

  this.cont = sub_cont;

  $(cont).append(sub_cont);

  cont = sub_cont;

  var el_stats = document.createElement('span');
  $(cont).append(el_stats, '<hr/>');
  $(el_stats).append('...');

  this.status = el_stats;

  var el_canvas = document.createElement('canvas');
  el_canvas.style['border'] = '2px solid black';
  el_canvas.width = '150';
  el_canvas.height = '150';
  $(cont).append(el_canvas, '<hr/>');

  this.canvas = el_canvas;
  
  var el_username = document.createElement('select');

  this.username = el_username;
  
  $(el_username).append('<option value="kevin">kevin</option>');
  $(el_username).append('<option value="travis">travis</option>');
  $(el_username).append('<option value="bob">bob</option>');
  $(cont).append(el_username);
  
  var el_connect_btn = document.createElement('input'); 
  var self = this;
  el_connect_btn.type = 'submit';
  el_connect_btn.onclick = function () {
    self.connect();
  };
  
  el_connect_btn.value = 'Connect';
  $(cont).append(el_connect_btn);
  var force_vectors = [
    ['U', [0.0, 0.0, 1.0, 1.0]],
    ['D', [0.0, 0.0, -1.0, 1.0]],
    ['R', [1.0, 0.0, 0.0, 1.0]],
    ['L', [-1.0, 0.0, 0.0, 1.0]],
  ];
  
  for (var x = 0; x < force_vectors.length; ++x) {
    var lab = force_vectors[x][0];
    var fvec = force_vectors[x][1];
    var btn = document.createElement('input');
    btn.value = lab;
    btn.type = 'submit';
    btn.onclick = function () {
      self.sendjson({
        subject:     'debug-control-move',
        tozone:      true,
        force:       fvec,
      });
    };
    $(cont).append(btn);
  }
};
