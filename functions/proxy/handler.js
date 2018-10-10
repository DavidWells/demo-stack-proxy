const AWS = require('aws-sdk');
const path = require('path');
const STATUS_CODES = require('http').STATUS_CODES;
const dynamodb = new AWS.DynamoDB({
  apiVersion: '2012-08-10',
  region: 'us-east-1',
});

const DASHBOARD_REGEX = /^\/dashboard\//;
const DASHBOARD_JSON_NAME = 'dashboard.json';
const FINAL_DASH_JSON_URI = `/dashboard/${DASHBOARD_JSON_NAME}`;
const S3_SUFFIX = '.s3.amazonaws.com';
const manifestURI = origin => `/manifests/${origin}/${DASHBOARD_JSON_NAME}`;

// Check to see if this URI even exists in DDB
// If NO respond with 404
// If YES, store incoming HOST and it's DDB ORIGIN
exports.viewerRequestHandler = async (evt, ctx, cb) => {
  try {
    let { request } = evt.Records[0].cf;
    const headers = request.headers;
    const host = headers.host[0].value;
    console.log('ctx.functionName', ctx.functionName);
    const tableName = `${ctx.functionName.replace(
      /us-east-1.|-viewerRequest/g,
      '',
    )}-originmap`;

    console.log('tableName', tableName);
    console.log('host', host);
    const domainData = await getDomainData(tableName, host);
    console.log('domainData', domainData);

    if (domainData.origin) {
      setHeaders(headers, {
        externalhost: host,
        externalorigin: domainData.origin,
        externaldashboard: domainData.dashboard,
      });
    } else {
      request = {
        body: 'Sorry this is 404',
        headers: {},
        status: 404,
        statusDescription: STATUS_CODES['404'],
      };
    }
    cb(null, request);
  } catch (err) {
    cb(err);
  }
};

// Check for incoming HOST and ORIGIN headers
// rewrite to ORIGIN
exports.originRequestHandler = (evt, ctx, cb) => {
  console.log('evt JSON', JSON.stringify(evt));
  let { request } = evt.Records[0].cf;
  const headers = request.headers;
  const origin = request.origin;
  const host = headers.host[0].value;
  const externalhost = getHeader(headers, 'externalhost');
  const externalorigin = getHeader(headers, 'externalorigin');
  const externaldashboard = getHeader(headers, 'externaldashboard');
  const externalDomainName = `${externaldashboard}${S3_SUFFIX}`;
  const projectOrigin = externalorigin.replace(S3_SUFFIX, '');
  const htmlExtRegex = /(.*)\.html?$/;
  const normalizedURI = normalizeURI(request.uri);

  console.log('host', host);
  console.log('origin', origin);
  console.log('externalhost', externalhost);
  console.log('externalorigin', externalorigin);
  console.log('externaldashboard', externaldashboard);

  if (externalorigin) {
    headers['host'] = [{ key: 'host', value: externalorigin }];
    origin.s3.domainName = externalorigin;
  }
  if (htmlExtRegex.test(request.uri) && !externaldashboard) {
    const uri = request.uri.replace(htmlExtRegex, '$1');
    return cb(null, redirect(uri));
  }

  // Change ORIGIN if dashboard URI
  if (
    externaldashboard &&
    (DASHBOARD_REGEX.test(request.uri) || request.uri === '/')
  ) {
    console.log('DASHBOARD URI!');
    setHeaders(headers, {
      host: externalDomainName,
    });
    origin.s3.domainName = externalDomainName;
    request.uri = normalizedURI === '/' ? `/dashboard/index.html` : request.uri;
  }

  // No pointing in directories, rewrite to index.html
  if (!path.extname(request.uri)) {
    request.uri =
      normalizedURI === '/' ? '/index.html' : `${normalizedURI}/index.html`;
  }

  // Rewrite any refs to /dashboard/dashboard.json
  if (request.uri === FINAL_DASH_JSON_URI) {
    request.uri = manifestURI(projectOrigin);
    origin.s3.domainName = externalDomainName;
  }

  cb(null, request);
};

const normalizeURI = uri => (uri === '/' ? uri : uri.replace(/\/$/, ''));

const getDomainData = (table, host) => {
  const params = {
    Key: {
      Host: {
        S: host,
      },
    },
    TableName: table,
  };
  console.log('getDomainData', table);
  return dynamodb
    .getItem(params)
    .promise()
    .then(data => {
      return (
        data.Item &&
        data.Item.Origin &&
        data.Item.Origin.S && {
          host: data.Item.Host.S,
          origin: data.Item.Origin.S,
          dashboard: data.Item.Dashboard && data.Item.Dashboard.S,
        }
      );
    });
};

const redirect = to => {
  return {
    status: '301',
    statusDescription: STATUS_CODES['301'],
    headers: {
      location: [{ key: 'Location', value: to }],
    },
  };
};

const setHeaders = (headers, obj) =>
  Object.keys(obj).forEach(key => {
    obj[key] ? (headers[key] = [{ key, value: obj[key] }]) : false;
  });

const getHeader = (headers, key) =>
  headers[key] && headers[key][0] && headers[key][0].value;
