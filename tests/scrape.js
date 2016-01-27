var _ = require('lodash');
var expect = require('chai').expect;
var scrape = require('../scrape');
var http = require('http');
var urlmod = require('url');

// Urls with domain 'server.rel' are adjusted such that their host
// is altered to the localhost:port of the test server.
var testdata = {
    url: 'http://server.com',
    images: [
        'https://server.abs/image1.gif',
        'http://server.abs/image2.gif',
        'http://server.rel/path/image3.gif',
        'http://server.rel/path/image4.gif',
    ],
    links: [
        'https://server.abs/link1',
        'http://server.abs/link2',
        'http://server.rel/path/link3',
        'http://server.rel/path/link4',
    ],
    html: `
        <!DOCTYPE html>
        <body>
        <img src="https://server.abs/image1.gif">
        <img src="//server.abs/image2.gif">
        <img src="//server.abs/image2.gif">
        <img src="/path/image3.gif">
        <img src="path/image4.gif">
        <a href="https://server.abs/link1">
        <a href="//server.abs/link2">
        <a href="/path/link3">
        <a href="/path/link3">
        <a href="path/link4">
        </body>
    `,
}

var server = http.createServer(function(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(testdata.html);
});


describe('scraping', function() {
    before(function(done) {
        server.listen(0, done);
    });

    after(function(done) {
        server.close(done);
    });

    function reladjust(urls) {
        return _.map(urls, function(url) {
            urlobj = urlmod.parse(url);
            if (urlobj.hostname === 'server.rel') {
                // urlmod.format ignores hostname if host is set
                urlobj.host = 'localhost:' + server.address().port;
            }
            return urlmod.format(urlobj);
        })
    }

    it('should scrape image links from a url', function() {
        var local = 'http://localhost:' + server.address().port;
        return scrape(local)
        .then(function(result) {
            expect(result.images).to.deep.equal(reladjust(testdata.images));
            expect(result.links).to.deep.equal(reladjust(testdata.links));
        })
    });

});
