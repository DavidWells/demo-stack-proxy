const AWS = require('aws-sdk');
const Promise = require('bluebird');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { ApolloClient } = require('apollo-client');
const { createHttpLink } = require('apollo-link-http');
const { setContext } = require('apollo-link-context');
const { InMemoryCache } = require('apollo-cache-inmemory');
const prettyjson = require('prettyjson');
const gql = require('graphql-tag');
const yaml = require('js-yaml');
const _filter = require('lodash.filter');
const _map = require('lodash.map');
const _chunk = require('lodash.chunk');

AWS.config.setPromisesDependency(Promise);
const cfn = new AWS.CloudFormation({ apiVersion: '2010-05-15' });
const s3 = new AWS.S3({ apiVersion: '2012–09–25' });

const { GITHUB_WEBHOOK_SECRET, GITHUB_ACCESS_TOKEN, CI_ROLE_ARN } = process.env;
const GITHUB_API = 'https://api.github.com/graphql';
const REPO_SLS_EXP = 'master:serverless.yml';
const FEAT_REGEX = /^(feat-)(.+)$/;
const S3_CONST = 'AWS::S3::Bucket';

const signRequestBody = (key, body) => {
  return `sha1=${crypto
    .createHmac('sha1', key)
    .update(body, 'utf-8')
    .digest('hex')}`;
};

module.exports.webhookHandler = async (event, context, callback) => {
  var errMsg;
  const headers = event.headers;
  const sig = headers['X-Hub-Signature'];
  const githubEvent = headers['X-GitHub-Event'];
  const id = headers['X-GitHub-Delivery'];
  const calculatedSig = signRequestBody(GITHUB_WEBHOOK_SECRET, event.body);

  if (typeof GITHUB_WEBHOOK_SECRET !== 'string') {
    errMsg = "Must provide a 'GITHUB_WEBHOOK_SECRET' env variable";
    return callback(null, {
      statusCode: 401,
      headers: { 'Content-Type': 'text/plain' },
      body: errMsg,
    });
  }

  if (!sig) {
    errMsg = 'No X-Hub-Signature found on request';
    return callback(null, {
      statusCode: 401,
      headers: { 'Content-Type': 'text/plain' },
      body: errMsg,
    });
  }

  if (!githubEvent) {
    errMsg = 'No X-Github-Event found on request';
    return callback(null, {
      statusCode: 422,
      headers: { 'Content-Type': 'text/plain' },
      body: errMsg,
    });
  }

  if (!id) {
    errMsg = 'No X-Github-Delivery found on request';
    return callback(null, {
      statusCode: 401,
      headers: { 'Content-Type': 'text/plain' },
      body: errMsg,
    });
  }

  if (sig !== calculatedSig) {
    errMsg = "X-Hub-Signature incorrect. Github webhook token doesn't match";
    return callback(null, {
      statusCode: 401,
      headers: { 'Content-Type': 'text/plain' },
      body: errMsg,
    });
  }

  if (githubEvent !== 'delete') {
    respond(event, callback);
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (error) {
    console.error('Unable to parse webhook payload', event.body);
    respond(event, callback);
  }

  console.log(
    `Github-Event: "${githubEvent}" with action: "${event.body.action}"`,
  );
  console.log('Payload', prettyjson.render(payload, {noColor: true})); // eslint-disable-line

  // Do custom stuff here with github event data
  // For more on events see https://developer.github.com/v3/activity/events/types/

  const repoOwner = payload.repository.owner.login;
  const repoName = payload.repository.name;
  const branch = payload.ref;

  if (FEAT_REGEX.test(branch)) {
    try {
      const stackname = await getStackname(repoName, branch, repoOwner, REPO_SLS_EXP); // eslint-disable-line
      const stackExists = await doesStackExist(stackname);

      if (stackExists) {
        const buckets = await getStackBuckets(stackname);
        await emptyBuckets(buckets);
        await deleteStack(stackname);
      }
    } catch (error) {
      console.error(error);
      respond(event, callback);
    }
  } else {
    console.log('Not a feat Branch', branch);
  }

  respond(event, callback);
};

const respond = (event, cb) =>
  cb(null, {
    statusCode: 200,
    body: JSON.stringify({
      input: event,
    }),
  });

const getStackname = (repoName, branch, repoOwner, expression) => {
  const httpLink = createHttpLink({
    uri: GITHUB_API,
    fetch: fetch,
  });
  const authLink = setContext((_, { headers }) => {
    return {
      headers: {
        ...headers,
        authorization: GITHUB_ACCESS_TOKEN
          ? `Bearer ${GITHUB_ACCESS_TOKEN}`
          : '',
      },
    };
  });
  const client = new ApolloClient({
    link: authLink.concat(httpLink),
    cache: new InMemoryCache(),
  });
  const query = gql`
    {
      repository(owner: "${repoOwner}", name: "${repoName}") {
        object(expression: "master:serverless.yml") {
          ... on Blob {
            text
          }
        }
      }
    }
  `;
  return client.query({ query }).then(({ data }) => {
    // console.log('data', prettyjson.render(data, {noColor: true})); // eslint-disable-line
    const slsyml = yaml.safeLoad(data.repository.object.text, 'utf8');
    // console.log('slsyml', prettyjson.render(slsyml, {noColor: true})); // eslint-disable-line
    const service = slsyml.service;
    const stackname = `${service}-${branch}`;
    console.log('stackname', stackname);
    return stackname;
  });
};

const doesStackExist = stackname =>
  cfn
    .describeStacks({
      StackName: stackname,
    })
    .promise()
    .then(data => {
      return true;
    })
    .catch(() => false);

const getStackBuckets = stackname =>
  cfn
    .describeStackResources({
      StackName: stackname,
    })
    .promise()
    .then(data =>
      _map(
        _filter(data.StackResources, { ResourceType: S3_CONST }),
        resource => resource.PhysicalResourceId,
      ),
    );

const doesBucketExist = bucket =>
  s3
    .headBucket({ Bucket: bucket })
    .promise()
    .then(() => true)
    .catch(() => false);

const emptyBucket = bucket =>
  doesBucketExist(bucket).then(
    doesExist =>
      doesExist &&
      listAllKeys({ Bucket: bucket }).then(keys =>
        deleteFiles(bucket, keys.map(key => ({ Key: key }))),
      ),
  );

const emptyBuckets = buckets =>
  Promise.all(buckets.map(bucket => emptyBucket(bucket)));

const listKeyPage = options => {
  const params = { ...options, MaxKeys: 1000 };
  return s3
    .listObjectsV2(params)
    .promise()
    .then(list => {
      const keys = list.Contents.map(item => item.Key);
      const startAfter = list.IsTruncated ? keys[keys.length - 1] : null;
      return { startAfter, keys };
    });
};

const listAllKeys = options => {
  let keys = [];
  const listKeysRecusively = StartAfter => {
    const params = { ...options, StartAfter };
    return listKeyPage(params).then(response => {
      const { startAfter, keys: keyset } = response;
      keys = keys.concat(keyset);
      if (startAfter) {
        return listKeysRecusively(startAfter);
      }
      return keys;
    });
  };
  return listKeysRecusively();
};

const deleteFiles = (bucket, objects) =>
  Promise.map(_chunk(objects, 1000), objectsChunk => {
    const deleteParams = {
      Bucket: bucket,
      Delete: {
        Objects: objectsChunk,
      },
    };
    return s3.deleteObjects(deleteParams).promise();
  });

const deleteStack = stackname =>
  cfn.deleteStack({ StackName: stackname, RoleARN: CI_ROLE_ARN }).promise();
