'use strict';

var _ = require('lodash');
var bodyParser = require('body-parser');
var core = require('./core');
var conf = require('./config');
var express = require('express');
var Promise = require('bluebird');

var app = express();
app.use(bodyParser.json());

// Backstop for any uncaught rejections.
function send_error(res) {
    return function(err) {
        res.status(500).send({error: err.message});
    }
}

app.post('/new', function(req, res) {
    Promise.try(function() {
        var urls = req.body;
        if (! _.isArray(urls)) {
            return res.status(400).send('expected list of urls, check input and encoding');
        }

        return core.create_job(urls)
        .then(function(job_id) {
            res.json({job_id: job_id});
        });
    })
    .catch(send_error(res));
});

app.get('/status/:job_id', function(req, res) {
    Promise.try(function() {
        var job_id = req.params['job_id'];
        if (!job_id){
            return res.status(400).send('missing job_id');
        }
        return core.get_status(job_id)
        .then(function(status) {
            if (!status) {
                return res.status(404).end();
            }
            res.json(status);
        })
    })
    .catch(send_error(res));
});

app.get('/results/:job_id', function(req, res) {
    Promise.try(function() {
        var job_id = req.params['job_id'];
        if (!job_id) {
            return res.status(400).send('missing job_id');
        }
        return core.get_results(job_id)
        .then(function(images) {
            if (!images) {
                return res.status(404).end();
            }
            res.json(images);
        })
    })
    .catch(send_error(res));
});

function api_init() {
    return new Promise(function(resolve, reject) {
        var server = app.listen(conf.get('port'), function() {
            console.log('listening on port ' + server.address().port);
            server.removeListener('error', reject);
            resolve();
        });
        server.on('error', reject);
    });
}

module.exports = {
    init: api_init,
}
