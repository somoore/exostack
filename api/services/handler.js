'use strict';

const {
  ok,
  badRequest,
  fail
} = require('./response');

const { checkIsAdmin, getUserRecord }   = require('./user');

const TenantsController  = require('./tenants');
const CloudsController   = require('./clouds');
const InstanceController = require('./instance');
const VpnController      = require('./vpnaccess');
const RoutingController  = require('./routing');
const S3BucketController = require('./s3Bucket');


const tenantsController  = new TenantsController();
const cloudsController   = new CloudsController();
const instanceController = new InstanceController();
const vpnController      = new VpnController();
const routingController  = new RoutingController();
const s3Bucketcontroller = new S3BucketController();

module.exports.modifyInstance = async (event, context) => {
  try {
    console.log(JSON.stringify(event));
    const { accountId, action, instanceId, region } = event.pathParameters || {};
    console.log({resource:event.resource, accountId, action, instanceId, region});

    // const { apiKeyName, sourceIp } = event.requestContext.identity;
    const { 'x-api-key': apiKey } = event.headers;
    const { ipAddress, description, username } = (event && event.body && JSON.parse(event.body)) || {};
    
    // TODO: Move to a common Lambda authorizer, because caching
    const {tenantId, tenantStatus, tenantValid, tenantMessage} = await tenantsController.validateTenant(event);
    if (!tenantValid) {
      return badRequest({message: tenantMessage});
    }

    cloudsController.init({ tenantId });

    if (event.httpMethod === 'GET' && event.resource === '/clouds') {
      const clouds = await cloudsController.getCloudsDisplay();
      return ok(clouds);
    }
  
    if (event.httpMethod === 'DELETE' && event.resource === '/clouds/{accountId}') {
      const cloudDeleted = await cloudsController.deleteCloud(accountId);
      return ok(cloudDeleted);
    }
    
    const clouds = await cloudsController.getClouds();
    const cloud = clouds.find(c => c.AccountId == accountId);
    if (typeof cloud === 'undefined') {
      console.error('CLOUD NOT FOUND', accountId, clouds, cloud);
      return badRequest({message: `Invalid cloud account requested.`});
    }

    // const instanceController = new InstanceController();
    await instanceController.init({cloud, region});
    
    if (event.httpMethod === 'GET' && event.resource === '/clouds/{accountId}/regions') {
      const regions = await instanceController.getEc2Regions();
      return ok(regions);
    }

    if (event.httpMethod === 'GET' && event.resource === '/clouds/{accountId}/regions/{region}/instances') {
      const username = apiKey;
      const { userTags } = await getUserRecord(username);
      console.log('getInstanceInfo', username, userTags);
      const instancesInfo = await instanceController.getInstanceInfo({ region, userTags, tenantId, accountId, includeRoutingDetails:true });
      // const userTags = event.requestContext.authorizer["custom:userTags"];
      // const instancesInfo = await instanceController.getInstanceInfo({ region, userTags: JSON.parse(userTags) });
      return ok(instancesInfo);
    }

    if (event.httpMethod === 'GET' && event.resource === '/clouds/{accountId}/regions/{region}/s3Buckets') {
      await s3Bucketcontroller.init({cloud, region});
      const s3BucketsInfo = await s3Bucketcontroller.getBuckets({region});
      return ok(s3BucketsInfo);
    }
    console.log(`Received request for ${action} for instance:${instanceId} [ ${JSON.stringify({accountId, region, /*sourceIp,*/ apiKey, ipAddress, description, username})} ]`);

    // const vpnController = new VpnController();
    await vpnController.init({cloud, region});
    await routingController.init({ cloud, region });
        
    let message;
    switch(action) {
      case 'vpnup':
        {
          // console.log('pasring', action);
          const port = parsePort(event);

          // console.log(`port`, port);
          if (!port) {
            return badRequest(`Invalid TCP port number value provided for VPN access. Expected integer between 0-65535.`);
          }
          message = await vpnController.allowUserAccess(username, apiKey, ipAddress, instanceId, port);
          return ok({
            ipAddress,
            apiKey,
            message
          });
        }
      case 'vpndown':
        message = await vpnController.revokeUserAccess(apiKey, ipAddress, instanceId);
        return ok({ipAddress, apiKey, message});

      case 'vpndeleterule':
        if (!description || !ipAddress) {
          return badRequest(`Invalid rule`);
        }
        message = await vpnController.revokeByDescription(description, ipAddress, instanceId);
        return ok({message});
      case 'status':
        message = await instanceController.getInstanceInfo({instanceId, region});
        return ok(message);
      case 'start':
        message = await instanceController.startInstance({instanceId, region});
        return ok({message});
      case 'stop':
        message = await instanceController.stopInstance({instanceId, region});
        return ok({message});
      case 'reboot':
        message = await instanceController.rebootInstance({instanceId, region});
        return ok({message});
      case 'terminate':
        message = await instanceController.terminateInstance({instanceId, region});
        return ok({message});
      case 'console':
        const console = await instanceController.getInstanceConsole({instanceId, region});
        return ok(console);
      case 'routing':
        const routeTable = await routingController.getInstanceRouteTable({instanceId, region});
        return ok(routeTable);
      default:
          return badRequest(`Invalid action request requested : (action: ${action}, instance: ${instanceId}, region:${region})`);
    }
  } catch(err) {
    console.error(err);
    return fail(err);
  }
}

module.exports.cleanupAccess = async(event, context) => {
  console.log(`Starting cleanup of all expired rules across all tenant clouds`);
  if (event.cleanup) {
    const clouds = await cloudsController.getClouds();
    for (const cloud of clouds) {
      const vpnController = new VpnController();
      await vpnController.init({cloud, region:null});
      
      console.log(`Executing cleanup of expired rules for cloud: ${JSON.stringify(cloud)}`);
      await vpnController.revokeExpiredAccessRules();
      const message = `Cleanup complete for cloud: ${cloud}`;
      console.log(message);
      // return message;
    }
    console.log(`Cleanup complete of all expired rules across all tenant clouds`);
    return;
  }
}

module.exports.modifyAccess = async (event, context) => {
  // console.log(event.resource, event.body, event.requestContext.identity, event.headers);
  let message;

  try {
    // const cloudsController = new CloudsController();

    // get the WAN IP address from the APIGW request headers
    // const {ip, apiKey: apiKeyName} = event.requestContext.identity || {};
    // get the username to validate admin actions
    const {accountId, region, username} = event.pathParameters || {};
    // get the Api Key used for the request
    // const {'x-api-key': apiKey} = event.headers; 
    const {tenantId, tenantStatus, tenantValid, tenantMessage} = await tenantsController.validateTenant(event);
    if (!tenantValid) {
      return badRequest({message: tenantMessage});
    }

    cloudsController.init({ tenantId });
    const clouds = await cloudsController.getClouds();
    const cloud = clouds.find(c => c.AccountId == accountId);
    // const vpnController = new VpnController();
    await vpnController.init({cloud, region});

    console.log(event.resource);
    switch(event.resource) {
      // case '/vpn/up':
      //   message = await vpnAccess.allowUserAccess(apiKey, ip, instanceId);
      //   return ok({ip, apiKey, message});

      // case '/vpn/down':
      //   message = await vpnAccess.revokeUserAccess(apiKey, ip);
      //   return ok({ip, apiKey, message});

      case `/clouds/{accountId}/regions/{region}/vpn/list/{username}`:
        // console.log(username, apiKey);
        // const isValidAdmin = await checkIsAdmin(username, apiKey);
        // if (!isValidAdmin) {
        //   return badRequest(`Invalid credentials provided for privileged operation`);
        // }
        const rules = await vpnController.listUserAccessRules(/*apiKey*/);
        return ok(rules);
      
      // case '/vpn/admin':
      //   const adminKey = JSON.parse(event.body)['AdminKey'];
      //   if (adminKey === process.env.AdminKey) {
      //     message = await vpnAccess.revokeUserAccess(apiKey, null);
      //     return ok({apiKey, message}); 
      //   } else {
      //     return badRequest(`Invalid Admin Key`); 
      //   }

      default:
        return badRequest('Invalid path');
    }

  } catch (err) {
    console.error(err);
    return fail(err);
  }
};

const parsePort = (event) => {
  let {port} = (event && event.body && JSON.parse(event.body)) || {};
  if (!port) {
    return false;
  }
  port = Number(port);
  if (Number.isInteger(port) && port >=0 && port <= 65535) {
    return port; 
  }
  return false;
}

module.exports.whatsmyip = async (event, context) => {
  try {
    const { sourceIp } = event.requestContext.identity;
    console.log('sourceIp', sourceIp);
    return ok({sourceIp});
  } catch (e) {
    console.error(e, JSON.stringify(event.requestContext));
  }
}
