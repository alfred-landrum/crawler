'use strict';

var convict = require('convict');

// According to SQS docs, 10 is the maximum allowed batch size; requests
// will return errors if batch size is set larger.
var SQS_MAX_BATCH_SIZE = 10;

// Define a schema
var conf = convict({
    env: {
        doc: "The applicaton environment.",
        format: ["production", "development", "test"],
        default: "production",
        env: "NODE_ENV",
    },
    port: {
        doc: "The port to bind.",
        format: "port",
        default: 8000,
        env: "PORT",
    },
    aws_region: {
        doc: "The name of the AWS region.",
        env: "AWS_DEFAULT_REGION",
        default: "us-west-2",
    },
    sqs_name: {
        doc: "The name of the AWS SQS queue",
        env: "CRAWLER_SQS_QUEUE_NAME",
        default: "crawler-worker-queue",
    },
    sqs_account: {
        doc: "The account that owns the AWS SQS queue, needed if different from AWS security settings.",
        env: "CRAWLER_SQS_ACCOUNT_ID",
    },
    // Note that VisibilityTimeout is set at queue creation time; calling
    // createQueue with different params (incl. VisibilityTimeout) will return
    // an error.
    sqs_visibility_secs: {
        doc: "The SQS visibility timeout of the sqs queue, in seconds.",
        format: 'int',
        default: 60,
        env: "CRAWLER_SQS_VISIBILITY_TIMEOUT_SECS",
    },
    // The SQS visibility timeout and request timeout are related, as the
    // visibility timeout should be long enough for our longest expected
    // time to download, parse, and further process a page.
    sqs_batch_size: {
        doc: "Batch size for SQS message sends and receives, max is " + SQS_MAX_BATCH_SIZE,
        format: 'int',
        validate: function(x) {
            return Number(x) <= SQS_MAX_BATCH_SIZE
        },
        default: 10,
        env: "CRAWLER_SQS_BATCH_SIZE",
    },
    request_timeout_secs: {
        doc: "The timeout for requesting a url during scraping.",
        format: 'int',
        default: 30,
        env: "CRAWLER_REQUEST_TIMEOUT_SECS",
    },
    redis_url: {
        doc: "The redis: url for the Redis server or cluster.",
        format: "*", // convict doesnt like redis:
        default: 'redis://127.0.0.1:6379',
        env: "CRAWLER_REDIS_URL",
    },
    job_info_linger_secs: {
        doc: "The amount of time for a finished job's info and image list to linger for api calls.",
        format: 'int',
        default: 3 * 24 * 60 * 60, // over the weekend
        env: "CRAWLER_JOB_INFO_LINGER_SECS",
    },
});

// Perform validation
conf.validate({strict: true});

module.exports = conf;
