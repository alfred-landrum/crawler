'use strict';

var _ = require('lodash');
var aws = require('aws-sdk');
var conf = require('./config');
var SqsConsumer = require('sqs-consumer');
var Promise = require('bluebird');

var BATCH_SIZE = conf.get('sqs_batch_size');

var sqs;
var sqs_queue_url;

// Enqueue the given list of tasks to the SQS queue, using as few
// sqs calls as possible.
function enqueue_tasks(tasks) {
    var batches = [];
    while (tasks.length) {
        batches.push(tasks.splice(0, Math.min(tasks.length, BATCH_SIZE)));
    }

    function send_batch(batch) {
        var entries = batch.map(function(val, ind) {
            return {
                Id: String(ind),
                MessageBody: JSON.stringify(val),
            }
        });

        return sqs.sendMessageBatchAsync({
            Entries: entries,
            QueueUrl: sqs_queue_url,
        });
    }

    return Promise.map(batches, send_batch);
}

// Expects a handler to be called as handler(message, done) when
// a message is pulled from SQS.
// Returns an object with start,stop methods for controlling callbacks,
// callee must call .start() to initiate queue handling.
function register_handler(handler) {
    var consumer = SqsConsumer.create({
        sqs: sqs,
        queueUrl: sqs_queue_url,
        batchSize: BATCH_SIZE,
        handleMessage: function(sqs_msg, done) {
            var message;
            try {
                message = JSON.parse(sqs_msg.Body);
            } catch (err) {
                // XXX: Should use SQS dead letter queue to store message
                // for later analysis.
                console.log('queue: JSON parse of message failed, dropping message', err);
                return done();
            }
            handler(message, done);
        }
    });

    return consumer;
}

function worker_init() {
    sqs = new aws.SQS({
        // Other AWS config expected from AWS_* environment variables
        region: conf.get('aws_region'),
    });

    sqs = Promise.promisifyAll(sqs);

    var params = {
        QueueName: conf.get('sqs_name'),
        Attributes: {
            VisibilityTimeout: String(conf.get('sqs_visibility_secs')),
        }
    };

    return sqs.createQueueAsync(params)
    .then(function(result) {
        sqs_queue_url = result.QueueUrl;
        console.log('queue: sqs_queue_url: ' + sqs_queue_url);
    });
}

module.exports = {
    enqueue_tasks: enqueue_tasks,
    register_handler: register_handler,
    init: worker_init,
}
