var fs = require('fs');

httphandler = {};

httphandler.handlerL2 = function (state, req, res, args, url) {
    if (url != '/interface') {
        if (url == '' || url == '/') {
            url = 'index.html';
        }

        console.log('serving url [' + url + ']');
        url = url.replace('..', '.');

        var ext = null;
        var type = 'text/plain';

        if (url.indexOf('.') > -1) {
            ext = url.substring(url.indexOf('.') + 1);
        }

        switch (ext) {
            case null: type = 'text/plain'; break;
            case 'css': type = 'text/css'; break;
            case 'gif':  type = 'image/gif'; break;
            case 'html': type = 'text/html'; break;
            case 'png': type = 'image/png'; break;
            case 'xml': type = 'text/xml'; break;
            case 'js': type = 'text/javascript'; break;
            case 'xsl': type = 'text/xsl; charset=utf-8;'; break;
            default:
                console.log('unknown extension ' + ext);
                type = 'text/plain';
                break;

        }

        var fstream = fs.createReadStream('./' + url);

        fstream.on('open', function () {
            res.writeHead(200, { 'Content-Type': type });
            fstream.pipe(res);
        });

        fstream.on('error', function (err) {
            console.log('err: ' + err);
            res.writeHead(400, { 'Content-Type': type });
            res.end();
        });

        fstream.on('end', function () {
            res.end();
        });

        return;
    }
    res.writeHead(403);
    res.end();
};


httphandler.handlerL1 = function (state, req, res, data) {
    var args = {};
    var url = req.url;
    if (url.indexOf('?') > -1) {
        var _args = url.substring(url.indexOf('?') + 1);
        _args = _args.split('&');
        for (var x = 0; x < _args.length; ++x) {
            var pair = _args[x].split('=');
            var key = pair[0];
            var value = pair[1];
            value = decodeURI(value);
            args[key] = value;
        }
        url = url.substring(0, url.indexOf('?'));
    }

    if (data != null) {
        var eargs = JSON.parse(data);
        for (var k in eargs) {
            args[k] = eargs[k];
        }
    }

    console.log('URL: ' + url);
    console.log(args);

    httphandler.handlerL2(state, req, res, args, url);
}


httphandler.handlerL0 = function (state, req, res) {
    if (req.method == 'POST') {
        var data = [];
        var datatotalsize = 0;
        req.on('data', function (chunk) {
            datatotalsize += chunk.length;
            if (datatotalsize > 1024 * 1024 * 4) {
                // Disable this potential DOS attack by limiting
                // the POST data to 4Mbytes.
                res.writeHead(403);
                res.end();
                return;
            }
            data.push(chunk);
        });

        req.on('end', function () {
            httphandler.handlerL1(state, req, res, data.join(''));
        });
        return;
    }

    httphandler.handlerL1(state, req, res, null);
}

module.exports = httphandler;
