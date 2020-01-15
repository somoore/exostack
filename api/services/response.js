'use strict';

const ok = (output) => {
  // console.log(output);
  return {
    statusCode: 200,
    body: JSON.stringify(output),
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*'
    }
  };
};

const html = ({htmlBody, wrap = true, injectAutoClose = false}) => {
  htmlBody = injectAutoClose ? 
    `${htmlBody} <br/><small>This window will automatically close in 5 seconds</small>
      <script>setTimeout(() => window.close(), 5000)</script>` 
    : htmlBody;
  htmlBody = wrap ? `<html>${htmlBody}</html>` : htmlBody;
  return {
    statusCode: 200,
    body: htmlBody,
    headers: {
      'Content-Type': 'text/html',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*'
    }
  };
};

const fail = (err) => {
  console.error(JSON.stringify(err));
  return {
    statusCode: 500,
    body: JSON.stringify(err),
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*'
    }
  };
};

const badRequest = (message, ...additionalInfo) => {
  console.error(message, additionalInfo);
  return {
    statusCode: 400,
    body: JSON.stringify(message),
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*'
    }
  };
};

module.exports = {
  ok,
  html,
  fail,
  badRequest,
};
