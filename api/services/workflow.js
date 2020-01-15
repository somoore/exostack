'use strict';

const uuid    = require('uuid/v4');
const shortid = require('shortid');
shortid.characters('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-+');

const {
  ok,
  badRequest,
  fail,
  html
} = require('./response');

const {
  doc: docClient,
  raw: dynamodb,
  conv: converter
} = require('./ddbClient')({ convertEmptyValues: true });

const jp = require('jsonpath');

const WorkflowsTableInfo = {
  TableName: process.env.WorkflowsDDBTableName,
  HashKey: 'tenantId',
  RangeKey: 'workflowId'
}

const WorkflowsDDBTenantIndexInfo = {
  TableName: process.env.WorkflowsDDBTableName,
  IndexName: process.env.WorkflowsDDBTenantIndexName,
  HashKey: 'tenantId',
}

const WorkflowsDDBInstanceIndexInfo = {
  TableName: process.env.WorkflowsDDBTableName,
  IndexName: process.env.WorkflowsDDBInstanceIndexName,
  HashKey  : 'tenantId',
  RangeKey : 'instanceId',
}

const WorkflowsRequestsTableInfo = {
  TableName: process.env.WorkflowRequestsDDBTableName,
  HashKey: 'workflowId',
  RangeKey: 'workflowRequestId'
}

const WorkflowRequestsDDBTenantIndexInfo = {
  TableName: process.env.WorkflowRequestsDDBTableName,
  IndexName: process.env.WorkflowRequestsDDBTenantIndexName,
  HashKey: 'tenantId',
}

const TenantsController = require('./tenants');
const tenantsController = new TenantsController();

const CloudsController = require('./clouds');
const cloudsController = new CloudsController();

const Ec2ClientManager = require('./ec2Client');
const clientManager = new Ec2ClientManager();

const user = require('./user');
const { scheduleExpiration } = require("./scheduler");

const validResourceTypes = { EC2: 'EC2', WorkSpaces: 'WorkSpaces' };
const serviceCodes = { EC2: 'AmazonEC2', WorkSpaces: 'AmazonWorkSpaces' };
const otherResourceTypes = { SubnetRouting: 'SubnetRouting' };

/*** MAIN entry point to the workflow functions */
module.exports.handler = async (event, context) => {
  // console.log(event);
  // console.log('event.pathParameters', event.pathParameters);
  try {
    const workflowEventBody   = (event && event.body && JSON.parse(event.body)) || {};
    const workflowQueryParams = (event && event.queryStringParameters) || {};
    const workflowPathParams  = (event && event.pathParameters) || {};
    const resourceType = validateResourceType(workflowPathParams, workflowEventBody);
    
    const { tenantId, tenantValid, tenantMessage } = await tenantsController.validateTenant(event);
    if (!tenantValid) {
      return badRequest({ message: tenantMessage });
    } else {
      cloudsController.init({ tenantId });
    }

    const { accountId, cloud, region } = await getCloudRegion(workflowPathParams);
    const methodResource = `${event.httpMethod} ${event.resource}`;
    console.log('methodResource', methodResource);

    switch (methodResource) {
      
      // Get the configured resource types supported
      case 'GET /clouds/{accountId}/regions/{region}/workflows/params/resourceTypes':
        return validResourceTypes;
        
      // Get parameters for creation of workflow
      case 'GET /clouds/{accountId}/regions/{region}/workflows/params/{resourceType}':
        if (!(cloud && region && resourceType)) {
          console.error(cloud, region, resourceType);
          return badRequest(`Invalid request parameters.`);
        }
        const workflowParams = await getWorkflowParams(cloud, region, resourceType);
        // console.log('workflowParams', workflowParams);
        return workflowParams;

      // Get all saved workflows for a tenant
      case 'GET /clouds/{accountId}/regions/{region}/workflows':
        return await getWorkflows(tenantId, accountId, region);

      // Get a single saved workflow
      case 'GET /clouds/{accountId}/regions/{region}/workflows/{workflowId}':
        const workflowId = workflowPathParams['workflowId'];
        const includeDetails = workflowQueryParams['details'] === 'true';
        return await getWorkflow({tenantId, workflowId, cloud, region, includeDetails});

      // Get a single saved workflow for instance subnet routing
      case 'GET /clouds/{accountId}/regions/{region}/workflows/instances/{instanceId}': 
        const instanceId = workflowPathParams['instanceId'];
        console.log(`:: module.exports.handler -> instanceId`, instanceId);
        return await getInstanceWorkflow({tenantId, instanceId, cloud, region});
        
      // Create new workflow
      case 'POST /clouds/{accountId}/regions/{region}/workflows':
        return await saveWorkflow(tenantId, accountId, region, workflowEventBody, true);

      // updates an existing workflow
      case 'PATCH /clouds/{accountId}/regions/{region}/workflows':
        return await saveWorkflow(tenantId, accountId, region, workflowEventBody, false);

      // Deletes an existing workflow
      case 'DELETE /clouds/{accountId}/regions/{region}/workflows':
        return await deleteWorkflow(tenantId, workflowEventBody);
        
      // Validate a list of AMI-Ids
      case 'POST /clouds/{accountId}/regions/{region}/workflows/params/EC2/validate':
        if (!(cloud && region)) {
          console.error(cloud, region);
          return badRequest(`Invalid request parameters.`);
        }
        const amiIdCsvList = workflowEventBody['amiIdCsvList'];
        const amis = await validateAMIs(cloud, region, amiIdCsvList);
        return ok(amis);

      // Validate a list of AMI-Ids
      case 'POST /clouds/{accountId}/regions/{region}/workflows/params/WorkSpaces/validate':
        if (!(cloud && region)) {
          console.error(cloud, region);
          return badRequest(`Invalid request parameters.`);
        }
        const bundleIdCsvList = workflowEventBody['bundleIdCsvList'];
        const bundles = await validateBundles(cloud, region, bundleIdCsvList);
        return ok(bundles);

      // Create new workflow request
      case 'POST /clouds/{accountId}/regions/{region}/workflows/requests':
        return await saveWorkflowRequest(tenantId, accountId, region, workflowEventBody);

      // Queries the estimated running cost of workspace
      case 'POST /clouds/{accountId}/regions/{region}/workflows/requests/pricing':
        if (!resourceType) { return badRequest({ message: `Invalid resource type.` }); }
        return await computePricingWrapper(resourceType, cloud, region, workflowEventBody);
                  
      // Get all saved workflows for a tenant
      case 'GET /clouds/{accountId}/regions/{region}/workflows/requests':
        const userEmail = event.requestContext.authorizer["email"];
        return await getWorkflowRequests(tenantId, accountId, region, userEmail);

      default:
        return badRequest(`Invalid request.`);

    }
  } catch (e) {
    console.error(e);
    return fail(e);
  }
}


/** Validates proper resource Type */
function validateResourceType(workflowPathParams, workflowEventBody) {
  const resourceType = workflowPathParams['resourceType'] || workflowEventBody['resourceType'];
  console.log('validateResourceType', resourceType);
  if (resourceType && Object.keys(validResourceTypes).includes(resourceType)) {
    return resourceType;
  }
  return null;
}

/** Extracts region and translates Account ID to cloud connection object  */
async function getCloudRegion(workflowPathParams) {
  const { accountId, region } = workflowPathParams;
  const cloud = await cloudsController.getCloud(accountId);
  return { accountId, cloud, region };
}

/** Fetches the resource type specific parameters for creation of workflow */
async function getWorkflowParams(cloud, region, resourceType) {
  console.log('getWorkflowParams', cloud, region, resourceType);
  switch(resourceType) {
    case validResourceTypes.EC2:
      return await getWorkflowParamsEC2(cloud, region);
    case validResourceTypes.WorkSpaces:
      return await getWorkflowParamsWorkSpaces(cloud, region);
    default:
      throw new Error(`Invalid resource type ${resourceType}`);
  }
}

const vpcMapper = vpc => {
  return {
    VpcId    : vpc.VpcId,
    CidrBlock: vpc.CidrBlock,
    Tags     : vpc.Tags,
  };
};

const subnetMapper = sn => {
  return {
    AvailabilityZone: sn.AvailabilityZone,
    CidrBlock       : sn.CidrBlock,
    VpcId           : sn.VpcId,
    SubnetId        : sn.SubnetId,
    Tags            : sn.Tags
  };
};

const securityGroupMapper = sg => {
  return {
    Description: sg.Description,
    GroupId    : sg.GroupId,
    GroupName  : sg.GroupName,
    VpcId      : sg.VpcId
  };
};

const imageMapper = ami => {
  const image = ami.result && Array.isArray(ami.result.Images) 
    && ami.result.Images.length === 1 && ami.result.Images[0];
  return {
    AmiResolved : !!image,
    Name        : image.Name,
    ImageId     : image.ImageId || ami.amiId,
    Architecture: image.Architecture,
    Description : image.Description,
  };
};

const imageMapper2 = image => {
  return {
    Name        : image.Name,
    ImageId     : image.ImageId,
    Architecture: image.Architecture,
    Description : image.Description,
  };
};

/** Fetches parameters required for EC2 workflow */
async function getWorkflowParamsEC2(cloud, region) {
  try {
    const ec2Client = await clientManager.getEc2Client({ cloud, region, service: 'EC2' });
    // console.log('getWorkflowParamsEC2', ec2Client, typeof ec2Client);
    const [vpcs, subnets, securityGroups, keyPairs, instanceTypes, images] = await Promise.all([
      ec2Client.describeVpcs().promise(),
      ec2Client.describeSubnets().promise(),
      ec2Client.describeSecurityGroups().promise(),
      ec2Client.describeKeyPairs().promise(),
      getInstanceTypes(cloud, region),
      // ec2Client.describeImages().promise()
    ]);
    // console.log('getWorkflowParamsEC2', vpcs, subnets);
    return ok({
      vpcs: vpcs.Vpcs.map(vpcMapper),
      subnets: subnets.Subnets.map(subnetMapper),
      securityGroups: securityGroups.SecurityGroups.map(securityGroupMapper),
      keyPairs: keyPairs.KeyPairs,
      instanceTypes
      // images: images.Images
    });
  } catch (err) {
    console.error(err);
    return fail({ message: err.message });
  }
}

/** Basic filters for querying EC2 pricing info */
function getEC2PricingBaseFilters(region) {
  const location = locationDescription(serviceCodes.EC2, region);
  console.log('getEC2PricingBaseFilters', region, location);
  return [
    {
      Field: 'ServiceCode',
      Type: 'TERM_MATCH',
      Value: serviceCodes.EC2
    },
    {
      Field: 'location',
      Type: 'TERM_MATCH',
      Value: location
    },
    {
      Field: 'productFamily',
      Type: 'TERM_MATCH',
      Value: 'Compute Instance'
    },
    {
      Field: 'tenancy',
      Type: 'TERM_MATCH',
      Value: 'Shared'
    },
    {
      Field: 'licenseModel',
      Type: 'TERM_MATCH',
      Value: 'No License required'
    },
    {
      Field: 'capacitystatus',
      Type: 'TERM_MATCH',
      Value: 'Used'
    },
    {
      Field: 'preInstalledSw',
      Type: 'TERM_MATCH',
      Value: 'NA'
    },
  ];
}

/** Gets the list of available instance types */
async function getInstanceTypes(cloud, region) { 

  if (region === 'us-gov-west-1') {
    const pricing_govuswest1 = require('./pricing/us-gov-west-1.json');
    // console.log(`: pricing_govuswest1`, pricing_govuswest1);
    return pricing_govuswest1;
  }

  if (region === 'us-gov-east-1') {
    const pricing_govuseast1 = require('./pricing/us-gov-east-1.json');
    console.log(`: pricing_govuseast1`, pricing_govuseast1);
    return pricing_govuseast1;
  }

  const filters  = getEC2PricingBaseFilters(region);
  filters.push({
    Field: 'currentGeneration',
    Type : 'TERM_MATCH',
    Value: 'Yes'
  });
  const { products } = await queryPricing(cloud, serviceCodes.EC2, filters);
  const instanceTypesArray = Array.from(
    new Set(
      products.map(p => {
        const { instanceType, instanceFamily, memory, vcpu, clockSpeed } = p.product.attributes;
        // stringify to get unique string values into the Set
        return JSON.stringify({ instanceType, instanceFamily, memory, vcpu, clockSpeed });
      })
  ))
  .map(jsonString => JSON.parse(jsonString))
  .sort((a, b) => a > b ? 1 : -1);
  // console.log(`: getInstanceTypes -> products`, instanceTypesArray);
  return instanceTypesArray;
  
  // const pricingClient = await clientManager.getEc2Client({ cloud, region: 'us-east-1', service: 'Pricing' }); // pricing API only served from 2 regions (us-east-1 & ap-south-1)
  // const instanceTypes = await pricingClient.getAttributeValues({
  //   ServiceCode: serviceCodes.EC2,
  //   AttributeName: 'instanceType',
  // }).promise();
  // return instanceTypes.AttributeValues.map(it => it.Value).filter(it => it.includes('.'));
}

const WORKSPACES_NOT_SUPPORTED = `WorkSpaces is not supported in this region.`;
const WORKDOCS_NOT_SUPPORTED = `WorkDocs is not supported in this region.`;

/** Constructs a WorkSpaces client object */
async function getWorkspacesClient(cloud, region) {
  const message = WORKSPACES_NOT_SUPPORTED;
  try {
    const workspacesClient = await clientManager.getEc2Client({ cloud, region, service: 'WorkSpaces' });
    const testBundles = await workspacesClient.describeWorkspaceBundles().promise();
    // if (!workspacesClient) {
    //   console.error('getWorkspacesClient', workspacesClient, typeof workspacesClient);
    // } else {
    //   console.log(`created Workspaces client`, workspacesClient);
    // }
    return { workspacesClient, message };
  } catch (wsErr) {
    console.error('getWorkspacesClient - wsErr: ', JSON.stringify(wsErr));
    if (wsErr.code === 'UnknownEndpoint') {
      return { message };
    }
    return { message: wsErr.message };
  }
}

/** Fetches parameters required for WorkSpaces  workflow */
async function getWorkflowParamsWorkSpaces(cloud, region) {
  return ok({}); // Bundle resolution using client-side lookup
  const { workspacesClient, message } = await getWorkspacesClient(cloud, region);
  if (!workspacesClient) {
    return fail({ message });
  }

  let awsBundles = [], nextToken = null;
  do {
    let nextBundles;
    ({ Bundles: nextBundles, NextToken: nextToken } = await workspacesClient.describeWorkspaceBundles({ Owner: 'AMAZON', NextToken: nextToken }).promise());
    awsBundles.push(...nextBundles);
  } while (typeof nextToken !== 'undefined');

  // const awsBundlesPricing = [];
  // for (const bundle of awsBundles.sort((x,y) => x.Name > y.Name ? 1 : 1)) {
  //   try {
  //     console.log('getting pricing', bundle.BundleId);
  //     const pricingInfo = await getWorkflowPricingWorkSpaces({cloud, region, bundle});
  //     awsBundlesPricing.push({ ...bundle, ...pricingInfo });
  //   } catch (err) {
  //     console.error(err);
  //     awsBundlesPricing.push(bundle);
  //   }
  // }

  return ok({
    awsBundles: awsBundles //Pricing,
    // userBundles: userBundles.Bundles
  });
}

/** Computes the pricing for the requested resource */
async function computePricingWrapper(resourceType, cloud, region, workflowEventBody) {
  try {
    const pricingInfo = await computePricing(resourceType, cloud, region, workflowEventBody);
    return ok(pricingInfo);
  } catch (error1) {
    console.error(error1);
    return fail(error1);
  }
}

async function computePricing(resourceType, cloud, region, workflowEventBody) {
    let pricingInfo;
    if (resourceType === 'EC2') {
      if (region.includes('gov')) {
        return { price: null };
      }
      pricingInfo = await getWorkflowPricingEC2({ cloud, region, workflowEventBody });
    }
    else if (resourceType === 'WorkSpaces') {
      const { requestBundle: bundleId } = workflowEventBody;
      pricingInfo = await getWorkflowPricingWorkSpaces({ cloud, region, bundleId });
    }
    return pricingInfo; 
}

/** Computes the pricing info for EC2 instance request */
async function getWorkflowPricingEC2({cloud, region, workflowEventBody}) {
  console.log('workflowEventBody', JSON.stringify(workflowEventBody));
  const { requestInstanceType, requestImage } = workflowEventBody;
  
  const ec2Client = await clientManager.getEc2Client({ cloud, region, service: 'EC2' });
  const { Images: [{ Description, Architecture, Platform }]} = await ec2Client.describeImages({
    ImageIds: [requestImage],
  }).promise();;
  
  console.log('getWorkflowPricingEC2', cloud, region, requestInstanceType, requestImage, Description, Architecture, Platform);

  const operatingSystem = parseOS(Description, Platform);
  const filters = getEC2PricingBaseFilters(region);
  filters.push(
    {
      Field: 'instanceType',
      Type: 'TERM_MATCH',
      Value: requestInstanceType
    },
    {
      Field: 'operatingSystem',
      Type: 'TERM_MATCH',
      Value: operatingSystem
    }
  );
  
  let { products, priceListLength, price, serviceCode } = await queryPricing(cloud, serviceCodes.EC2, filters);

  if (price) {
    const HoursPerDay = 24;
    const DaysPerMonthAvg = 30.5;
    price = parseFloat(price * DaysPerMonthAvg * HoursPerDay).toFixed(2);
  }

  return {
    operatingSystem,
    requestInstanceType,
    products,
    serviceCode,
    priceListLength,
    price
  };
}

/** Parses operating system info required for pricing lookup */
function parseOS(description, platform) {
  console.log('getOS', description, platform);
  if (platform === 'windows') {
    return 'Windows';
  }
  if (description && (description.includes('Red Hat ') || description.includes('RHEL ')) ) {
    return 'RHEL';
  }
  if (description && description.includes('SUSE')) {
    return 'SUSE';
  }
  return 'Linux';
}

/** Computes the pricing info for Workspaces Bundle */
async function getWorkflowPricingWorkSpaces({cloud, region, bundle = null, bundleId = null, workspacesClient = null}) {
  console.log('getWorkflowPricingWorkSpaces', cloud, region, !!bundle, bundleId, !!workspacesClient);
  if (!bundle) {
    workspacesClient = workspacesClient || (await getWorkspacesClient(cloud, region)).workspacesClient;
    if (!workspacesClient) {
      return fail({ message: WORKSPACES_NOT_SUPPORTED });
    }
    ({ Bundles: [bundle] } = await workspacesClient.describeWorkspaceBundles({ BundleIds: [bundleId] }).promise());
  }
  const {
    Name = '',
    ComputeType: { Name: computeType } = {},
    UserStorage: { Capacity: userVolume } = {},
    RootStorage: { Capacity: rootVolume } = {}
  } = bundle;

  const operatingSystem = Name.toUpperCase().includes('WINDOWS') ? 'Windows' : 'Amazon Linux';
  const isPlusBundle    = Name.toUpperCase().includes('OFFICE');
  // const officeVersion   = isPlusBundle && Name.matchAll(/Office (\d*)/g)[0];
  console.log(Name, computeType, computeTypeToBundle(computeType), operatingSystem, isPlusBundle, userVolume, rootVolume, /*officeVersion,*/);

  const filters = [
    {
      Field: 'ServiceCode',
      Type: 'TERM_MATCH',
      Value: serviceCodes.WorkSpaces
    },
    {
      Field: 'bundle',
      Type: 'TERM_MATCH',
      Value: computeTypeToBundle(computeType) + (isPlusBundle ? ' Plus' : '') 
    },
    {
      Field: 'location',
      Type: 'TERM_MATCH',
      Value: locationDescription(serviceCodes.WorkSpaces, region)
    },
    {
      Field: 'operatingSystem',
      Type: 'TERM_MATCH',
      Value: operatingSystem
    },
    {
      Field: 'runningMode',
      Type: 'TERM_MATCH',
      Value: 'AlwaysOn' // monthly
    },
    {
      Field: 'license',
      Type: 'TERM_MATCH',
      Value: (operatingSystem === 'Windows' ? 'Included' : 'None')
    },
    {
      Field: 'resourceType',
      Type: 'TERM_MATCH',
      Value: 'Hardware'
    },
    {
      Field: 'userVolume',
      Type: 'TERM_MATCH',
      Value: userVolume + ' GB'
    },
    {
      Field: 'rootVolume',
      Type: 'TERM_MATCH',
      Value: rootVolume + ' GB'
    },
  ];
  console.log('filters', JSON.stringify(filters));

  const { price, priceListLength, serviceCode } = await queryPricing(cloud, serviceCodes.WorkSpaces, filters);

  return {
    computeType,
    operatingSystem,
    isPlusBundle,  // officeVersion 
    serviceCode,
    priceListLength,
    price,
  };
}

/** query Price List API  */
// Price List API only served from us-east-1 and ap-south-1
async function queryPricing(cloud, serviceCode, filters) {
  const pricingClient = await clientManager.getEc2Client({ cloud, region: 'us-east-1', service: 'Pricing' }); 
  console.log('queryPricing', serviceCode, 'filters', JSON.stringify(filters));
  let products = [], nextToken = null;
  do {
    let nextProducts;
    ({ PriceList: nextProducts, NextToken: nextToken } = await pricingClient.getProducts({
      ServiceCode  : serviceCode,
      Filters      : filters,
      FormatVersion: 'aws_v1',
      NextToken    : nextToken }).promise());
    products.push(...nextProducts);
    console.log(`: queryPricing -> `, { nextProducts, productsLength:products.length, nextToken });
  } while (typeof nextToken !== 'undefined');

  // console.log('queryPricing','products', JSON.stringify(products));
  
  //  products.PriceList[0].terms.OnDemand[0].priceDimensions[0].pricePerUnit.USD
  let price = products && products.length === 1 && jp.query(products, '$..USD')[0]; 
  if (price && !Number.isNaN(parseFloat(price))) {
    price = parseFloat(price).toFixed(2);
  }

  return {
    serviceCode,
    products,
    priceListLength: products && products.length,
    price
  };
}

function properCase(txt) {
  return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
}

/** Resolves a region code to a location description used for Price List API for a given service */
function locationDescription(serviceCode, region) {
  const regionToDescription = {
    [serviceCodes.WorkSpaces]: {
      'us-east-1'     : 'US East (N. Virginia)',
      'us-west-2'     : 'US West (Oregon)',
      'ap-northeast-1': 'Asia Pacific (Tokyo)',
      'ap-northeast-2': 'Asia Pacific (Seoul)',
      'ap-southeast-1': 'Asia Pacific (Singapore)',
      'ap-southeast-2': 'Asia Pacific (Sydney)',
      'ca-central-1'  : 'Canada (Central)',
      'eu-central-1'  : 'EU (Frankfurt)',
      'eu-west-1'     : 'EU (Ireland)',
      'eu-west-2'     : 'EU (London)',
      'sa-east-1'     : 'South America (Sao Paulo)',
      'us-gov-west-1' : 'AWS GovCloud (US)',
    },
    [serviceCodes.EC2]: {
      'us-east-2'     : 'US East (Ohio)',
      'us-east-1'     : 'US East (N. Virginia)',
      'us-west-1'     : 'US West (N. California)',
      'us-west-2'     : 'US West (Oregon)',
      'ap-east-1'     : 'Asia Pacific (Hong Kong)',
      'ap-south-1'    : 'Asia Pacific (Mumbai)',
      'ap-northeast-3': 'Asia Pacific (Osaka-Local)',
      'ap-northeast-2': 'Asia Pacific (Seoul)',
      'ap-southeast-1': 'Asia Pacific (Singapore)',
      'ap-southeast-2': 'Asia Pacific (Sydney)',
      'ap-northeast-1': 'Asia Pacific (Tokyo)',
      'ca-central-1'  : 'Canada (Central)',
      'cn-north-1'    : 'China (Beijing)',
      'cn-northwest-1': 'China (Ningxia)',
      'eu-central-1'  : 'EU (Frankfurt)',
      'eu-west-1'     : 'EU (Ireland)',
      'eu-west-2'     : 'EU (London)',
      'eu-west-3'     : 'EU (Paris)',
      'eu-north-1'    : 'EU (Stockholm)',
      'sa-east-1'     : 'South America (Sao Paulo)',
      'us-gov-east-1' : 'AWS GovCloud (US-East)',
      'us-gov-west-1' : 'AWS GovCloud (US)'
    }
  };
  const description = regionToDescription[serviceCode][region];
  return description;
}

function computeTypeToBundle(computeType) {
  const computeTypeBundles = {
    'VALUE'      : 'Value',
    'STANDARD'   : 'Standard',
    'PERFORMANCE': 'Performance',
    'POWER'      : 'Power',
    'GRAPHICS'   : 'Graphics',
    'POWERPRO'   : 'PowerPro',
    'GRAPHICSPRO': 'GraphicsPro',
  };
  return computeTypeBundles[computeType];
}

/** Validates a CSV list of AMI-IDs and resolves to their names */
async function validateAMIs(cloud, region, amiIdCsvList) {
  const amiList = Array.from(new Set(amiIdCsvList.split(',').map(a => a.trim())));
  if (!(Array.isArray(amiList) && amiList.length > 0)) {
    return badRequest(`Invalid list of EC2 AMIs`);
  }
  console.log('validateAMIs', cloud, region, amiIdCsvList, amiList);
  const ec2Client = await clientManager.getEc2Client({ cloud, region, service: 'EC2' });
  const amis = await Promise.all(
    amiList.map(
      amiId => {
        const filterBy = amiId.startsWith('ami-') ? 'image-id' : 'name';
        return ec2Client.describeImages({
          Filters: [{ Name: filterBy, Values: [amiId] }]
        }).promise()
          .then(result => {
            return {
              amiId,
              result
            }
          }).catch(err => {
            console.error(`: validateAMIs -> err`, err);
            return {
              amiId,
              result: null
            }
          })
      }
    )
  );
  console.log('amis', JSON.stringify(amis));
  return amis && amis.map(imageMapper);
}

/** Validates a CSV list of AMI-IDs and resolves to their names */
async function validateBundles(cloud, region, bundleIdCsvList) {
  const bundleIdList = Array.from(new Set(bundleIdCsvList.split(',').map(a => a.trim())));
  if (!(Array.isArray(bundleIdList) && bundleIdList.length > 0)) {
    return badRequest(`Invalid list of EC2 AMIs`);
  }
  console.log('validateBundles', cloud, region, bundleIdCsvList, bundleIdList);
  const { workspacesClient, message } = await getWorkspacesClient(cloud, region);
  if (!workspacesClient) {
    return fail({ message });
  }
  const bundles = await Promise.all(
    bundleIdList.map(
      bundleId => workspacesClient.describeWorkspaceBundles({
        BundleIds: [bundleId] 
      }).promise()
      .then(result => {
        return {
          bundleId,
          result
        }
      }).catch(err => {
        console.error(`: validateBundles -> err`, err);
        return {
          bundleId,
          result: null
        }
      })
    )
  );
  console.log('bundles', JSON.stringify(bundles));
  return bundles && bundles.map(bundle => {
    const image = bundle.result && Array.isArray(bundle.result.Bundles) && bundle.result.Bundles.length === 1 && bundle.result.Bundles[0];
    return {
      BundleResolved: !!image,
      Name          : image && image.Name,
      BundleId      : (image && image.BundleId)  || bundle.bundleId,
      Owner         : image && image.Owner,
      Description   : image && image.Description,
    }
  });
}

/** Fetches info for a single workflow, optionally including details of each sub-component  */
async function getWorkflow({tenantId, workflowId, cloud, region, includeDetails}) {
  console.log('getWorkflow', tenantId, workflowId, includeDetails);
  if (!workflowId) {
    console.error(`Error fetching requested workflow`, tenantId, JSON.stringify(workflowEventBody));
    return badRequest({message: `Required parameters not provided.`});
  }
  let workflowItem = await getWorkflowItem(tenantId, workflowId);
  if (!includeDetails) {
    return ok(workflowItem);
  }

  const { 
    resourceType, workflowName, 
    approvers, approvalOptions,
    vpcs, subnets, securityGroups, images, 
    instanceTypes, keyPairs, 
    leaseOptions,
    
    volumeTypes, storageOptions,
    bundles, workspaceOptions, 
  } = workflowItem;
  console.log('workflow', workflowItem, resourceType);
  let workflowDetails;
  if (resourceType === validResourceTypes.EC2) {
    console.log('getWorkflow', 'fetching EC2 details');
    const ec2Client = await clientManager.getEc2Client({ cloud, region, service: 'EC2' });
    const [vpcDetails, subnetDetails, securityGroupDetails, imageDetails, keyPairDetails] = await Promise.all([
      ec2Client.describeVpcs({ VpcIds: vpcs }).promise(),
      ec2Client.describeSubnets({ SubnetIds: subnets }).promise(),
      ec2Client.describeSecurityGroups({ GroupIds: securityGroups }).promise(),
      ec2Client.describeImages({ ImageIds: images }).promise(),
      ec2Client.describeKeyPairs({ KeyNames: keyPairs }).promise(),
    ]);
    workflowDetails = {
      // ...workflowItem,
      workflowId, resourceType, workflowName, 
      approvers, approvalOptions,
      vpcDetails          : vpcDetails.Vpcs.map(vpcMapper),
      subnetDetails       : subnetDetails.Subnets.map(subnetMapper),
      securityGroupDetails: securityGroupDetails.SecurityGroups.map(securityGroupMapper),
      imageDetails        : imageDetails.Images.map(imageMapper2),
      keyPairDetails      : keyPairDetails.KeyPairs,
      instanceTypes,
      leaseOptions,
      volumeTypes, 
      storageOptions
    };
    return ok(workflowDetails);

  } else if (resourceType === validResourceTypes.WorkSpaces) {
    const { workspacesClient, message } = await getWorkspacesClient(cloud, region);
    if (!workspacesClient) {
      return fail({ message });
    }
    const bundleDetails = [];
    do {
      // console.log('bundles-length', bundles.length, 'bundleDetails', bundleDetails.length);
      const bundleDetailsBatch = await workspacesClient.describeWorkspaceBundles({ BundleIds: bundles.splice(0, 25) }).promise();
      bundleDetails.push(...bundleDetailsBatch.Bundles);
    } while (bundles.length > 0)

    workflowDetails = {
      // ...workflowItem,
      workflowId, resourceType, workflowName,
      approvers, approvalOptions,
      awsBundleDetails: bundleDetails,
      workspaceOptions
    };
    return ok(workflowDetails);

  } else {
    return fail({ message: `Invalid resource type for the selected workflow.`, workflowId, resourceType });
  }
}

/** Queries for a single workflow record */
async function getWorkflowItem(tenantId, workflowId) {
  const workflow = await docClient.get({
    TableName: WorkflowsTableInfo.TableName,
    Key: {
      tenantId,
      workflowId
    }
  }).promise();
  let workflowItem;
  if (workflow && workflow.Item) {
    workflowItem = workflow.Item;
  }
  return workflowItem;
}

/** Queries for a single instance workflow */
async function getInstanceWorkflow({ tenantId, instanceId, cloud, region }) {
  if (!instanceId) {
    console.error(`Error fetching requested workflow`, tenantId, JSON.stringify(workflowEventBody));
    return badRequest({ message: `Required parameters not provided.` });
  }
  const workflowItem = await getInstanceWorkflowItem(tenantId, instanceId);
  console.log(`:: getInstanceWorkflow -> workflowItem`, workflowItem);
  return ok(workflowItem);
}

/** Queries for a single instance workflow record */
async function getInstanceWorkflowItem(tenantId, instanceId) {
  const workflow = await docClient.query({
    TableName: WorkflowsDDBInstanceIndexInfo.TableName,
    IndexName: WorkflowsDDBInstanceIndexInfo.IndexName,
    KeyConditionExpression: 'tenantId = :t AND instanceId = :i',
    ExpressionAttributeValues: {
      ':i': instanceId,
      ':t': tenantId,
    },
    ProjectionExpression: 'workflowId, resourceType, instanceId, enableSubnetRouting, approvers'
  }).promise();
  console.log(`:: getInstanceWorkflowItem -> workflow`, workflow);
  let workflowItem;
  if (workflow && workflow.Count === 0) {
    workflowItem = {};
  } else if (workflow && workflow.Count === 1) {
      workflowItem = workflow.Items[0];
  } else if (workflow && workflow.Count > 1) {
      const message = `Expected single subnet routing configuration workflow record. Found: ${workflow.Items.length} records.`;
      console.error(message);
      throw new Error(message);
  }
  return workflowItem;
}

/** Gets a list of workflows available in a cloud account and region */
async function getWorkflows(tenantId, accountId, region) {
  console.log('getWorkflows', tenantId);
  const workflows = await docClient.query({
    TableName: WorkflowsTableInfo.TableName,
    IndexName: WorkflowsDDBTenantIndexInfo.IndexName,
    KeyConditionExpression: 'tenantId = :t',
    FilterExpression: 'accountId = :a AND #region = :r',
    ExpressionAttributeValues: {
      ':t': tenantId,
      ':a': accountId,
      ':r': region
    },
    ExpressionAttributeNames: {
      '#region' : 'region'
    },
    ProjectionExpression: 'workflowId, workflowName, workflowStatus, resourceType, tenantId, accountId, #region'
  }).promise();
  return ok(workflows && workflows.Items && workflows.Items.filter(workflow => Object.keys(validResourceTypes).includes(workflow.resourceType))
    .map(workflow => {
      return {
        workflowId    : workflow.workflowId,
        workflowName  : workflow.workflowName,
        resourceType  : workflow.resourceType,
        workflowStatus: workflow.workflowStatus,
        createdAt     : workflow.createdAt
      }
  }));
}

/** Saves a workflow instance */
async function saveWorkflow(tenantId, accountId, region, workflowEventBody, createNew = false) {
  console.log(`Saving workflow`, tenantId, JSON.stringify(workflowEventBody));
  let workflowId, creation, updation;
  const timestamp = new Date().toISOString();
  if (createNew) {
    workflowId = uuid();
    creation = {
      createdAt: timestamp,
      workflowStatus: 'ACTIVE'
    };
  } else {
    workflowId =  workflowEventBody['workflowId'];
    if (!workflowId) {
      console.error(`Unable to edit workflow.`, workflowId);
      return badRequest({message: `Required parameters not provided.`});
    }
    updation = {
      editedAt : timestamp
    };
  }
  const workflowInfo = Object.assign(workflowEventBody, 
    {
      tenantId,
      workflowId,
      accountId, 
      region
    },
    creation,
    updation
  );
  console.log('workflowInfo', JSON.stringify(workflowInfo));
  const newWorkflow = await docClient.put({
    TableName: WorkflowsTableInfo.TableName,
    Item: workflowInfo
  }).promise();
  return ok({ workflowId });
}

/**
 * Deletes a single workflow 
 * @param {string} tenantId 
 * @param {Object} workflowEventBody 
 */
async function deleteWorkflow(tenantId, workflowEventBody) {
  const workflowId = workflowEventBody['workflowId'];
  if (!workflowId) {
    console.error(`Error deleting requested workflow`, tenantId, JSON.stringify(workflowEventBody));
    return badRequest({message: `Required parameters not provided.`});
  }
  console.log(`Deleting workflow - tenantId: ${tenantId} , workflowId: ${workflowId}`);
  const workflowDeleted = await docClient.delete({
    TableName: WorkflowsTableInfo.TableName,
    Key: {
      [WorkflowsTableInfo.HashKey]:tenantId,
      [WorkflowsTableInfo.RangeKey]:workflowId
    }
  }).promise();
  return ok({ message: `Workflow deleted` });
}

/** Saves a workflow request */
async function saveWorkflowRequest(tenantId, accountId, region, workflowEventBody) {
  console.log(`Saving workflow request`, tenantId, JSON.stringify(workflowEventBody));
  const { workflowId, workflowName, resourceType } = workflowEventBody;
  if (!workflowId) {
    return badRequest({ message: `Required parameters not provided.`});
  }

  const workflowRequestId = shortid.generate(); //uuid();
  const createdAt = new Date().toISOString();
  const workflowRequestStatus = 'SUBMITTED';
  const workflowRequestInfo = Object.assign(workflowEventBody, 
    {
      tenantId,
      accountId, 
      region,    
      workflowRequestId,
      workflowRequestStatus,
      createdAt,
    }
  );
  console.log('workflowRequestInfo', JSON.stringify(workflowRequestInfo));
  const newWorkflowRequest = await docClient.put({
    TableName: WorkflowsRequestsTableInfo.TableName,
    Item: workflowRequestInfo
  }).promise();

  const execution = await initiateApproval(workflowRequestInfo);
  console.log(`initiateApproval -> execution`, execution);

  return ok({ workflowRequestId, workflowId, workflowName, resourceType, workflowRequestStatus, createdAt });
}

/** Gets a list of workflow requests available in a cloud account and region */
async function getWorkflowRequests(tenantId, accountId, region, requester) {
  console.log('getWorkflowRequests', tenantId, accountId, region, requester);
  const workflows = await docClient.query({
    TableName: WorkflowRequestsDDBTenantIndexInfo.TableName,
    IndexName: WorkflowRequestsDDBTenantIndexInfo.IndexName,
    KeyConditionExpression: 'tenantId = :t',
    FilterExpression: 'accountId = :a AND #region = :r AND requester = :u',
    ExpressionAttributeValues: {
      ':t': tenantId,
      ':a': accountId,
      ':r': region,
      ':u': requester
    },
    ExpressionAttributeNames: {
      '#region' : 'region'
    },
    ProjectionExpression: 'workflowId, workflowRequestId, workflowName, workflowRequestStatus, resourceType, tenantId, accountId, #region, createdAt'
  }).promise();
  return ok(workflows && workflows.Items);
}

const AWS = require('aws-sdk');
const stepFunc = new AWS.StepFunctions();

/** Kicks off the execution of the resource approval workflow */
async function initiateApproval(workflowRequest) {
  const { tenantId, workflowId, workflowRequestId } = workflowRequest;
  const { approvers, approvalOptions } = workflowRequest; //await getWorkflowItem(tenantId, workflowId);
  const workflowExecutionName = `${workflowId}___${workflowRequestId}`;
  const workflowInput = JSON.stringify({ ...workflowRequest, approvers, approvalOptions });

  const execution = await stepFunc.startExecution({
    stateMachineArn: process.env.WorkflowApprovalStateMachineARN,
    input: workflowInput,
    name: workflowExecutionName
  }).promise();
  console.log(`Started execution of workflow @ ${execution.startDate.toISOString()}`, workflowExecutionName, execution.executionArn);

  return execution;
}

module.exports.tasks = async (event, context) => {
  console.log(JSON.stringify(event));
  const {
    taskToken,
    httpMethod,
    resource,
    pathParameters: { requestId, action } = {},
    queryStringParameters: { responseToken } = {},
    mailApprover, approverNumber,
    launch,
    input: workflowRequest
  } = event;
  const methodResource = `${httpMethod} ${resource}`;
  console.log('methodResource', methodResource);
  if (methodResource === 'GET /workflows/requests/{requestId}/{action}') {
    console.log('requestId', requestId, 'action', action, 'responseToken', responseToken);
    return await handleApprovalResponse(action, responseToken, requestId);

  } else if (mailApprover) {
    await mailerTask(taskToken, event, approverNumber);

  } else { // if (launch) {
    // check for approvals and launch
    const { launchRequest, launchResult }  = await launchResource(event);

    // notify requester of launch outcome
    const { requester, subject, mailBody } = composeLaunchMail(launchRequest, launchResult);
    const notificationSent = await notifyUser(requester, subject, mailBody);

    // update request status
    await updateWorkflowRequestStatus(launchRequest, launchResult, notificationSent);

    return launchResult;
  }
}

const SES = new AWS.SES();

async function mailerTask(taskToken, event, approverNumber) {
  const { input:workflowRequest } = event;
  const { resourceType, approvers } = workflowRequest;
  const approverEmail = approvers[approverNumber - 1];
  console.log('resourceType', resourceType, 'token', taskToken, 'approverEmail', approverEmail, approvers, approverNumber);

  if (!approverEmail) {
    return await stepFunc.sendTaskSuccess({
      taskToken,
      output: JSON.stringify({ Approved: false, Reason: `Approver # ${approverNumber} does not exist.` })
    }).promise();
  }

  let subject, mailBody;
  if (Object.keys(validResourceTypes).includes(resourceType)) {
    ({ subject, mailBody } = await composeApprovalMail(approverEmail, workflowRequest, taskToken));
  } else if (Object.keys(otherResourceTypes).includes(resourceType)) {
    ({ subject, mailBody } = await composeSubnetRoutingApprovalMail(approverEmail, workflowRequest, taskToken));
    console.log(`:: mailerTask -> subject, mailBody`, subject, mailBody);
  }
  await notifyUser(approverEmail, subject, mailBody);
}

/** Sends the actual email using SES API */
async function notifyUser(toEmailAddress, subject, mailBody) {
  console.log(`:: notifyUser -> toEmailAddress, subject`, toEmailAddress, subject);
  try {
    const email = await SES.sendEmail({
      Source: process.env.EmailSenderAddress,
      Destination: {
        ToAddresses: [toEmailAddress]
      },
      Message: {
        Subject: { Data: subject },
        Body: { Html: { Data: mailBody } }
      },
    }).promise();
    console.log(`Email sent to ${toEmailAddress}`, email.MessageId);
    return true;
  } catch(err) {
    console.error(`Unable to send mail to ${toEmailAddress}`, err);
    return false;
  }

}

/** Creates the links embedded in the approval mail */
function createApprovalLinks(workflowRequestId, taskToken) {
  const apiGatewayURL = process.env.ApiGatewayBaseURL;
  return ['approve', 'reject'].map(action => {
    return `<a href="${apiGatewayURL}/workflows/requests/${workflowRequestId}/${action}?responseToken=${encodeURIComponent(taskToken)}">${action.toUpperCase()}</a>`;
  });
}

function getLinksValidity() {
  const linksValidTill = new Date();
  const linksValidityHrs = process.env.ApprovalMailLinksValidityHrs;
  linksValidTill.setTime(linksValidTill.getTime() + (linksValidityHrs * 60 * 60 * 1000));
  return linksValidTill;
}

/** Compose the approval mail */
async function composeSubnetRoutingApprovalMail(approverEmail, workflowRequest, taskToken) {
  const {
    tenantId, accountId, region,
    requester, resourceType, workflowRequestId, requestReason,
    instanceId,
    leaseOptions: { leaseAction, leaseDuration, leaseDurationUnit }
  } = workflowRequest;
  console.log(`:: composeSubnetRoutingApprovalMail -> approverEmail`, approverEmail);
  const subject = `Exostack Workflow Approval Request - ${workflowRequestId}`;
  const [approvalLink, rejectionLink] = createApprovalLinks(workflowRequestId, taskToken);
  const linksValidTill = getLinksValidity();

  const mailBody = `Hey ${approverEmail || ''}, <br/><br/>

  <span>Please review the below request for launching new AWS ${resourceType} resources using the Exostack Self-Service Portal - </span>

  <ul>
    <li> Requester : ${requester}</li>
    <li> Account : ${accountId}</li>
    <li> Region : ${region}</li>
    <li> Instance : ${instanceId} </li>
    <li> Action : ${leaseAction} </li>
    <li> Duration : ${leaseDuration} ${leaseDurationUnit} </li>
    <li>
      ${JSON.stringify(workflowRequest)} 
    </li>
  </ul>

    To approve this request, click ${approvalLink} <br/>
    To reject this request, click ${rejectionLink} <br/>
    
    <br/>
    
    These links are only usable once and valid till ${linksValidTill.toUTCString()}.<br/><br/>

    Thanks! <br/>
    Exostack Team

    <br/><br/>
    <small>Note - This is an automated email and replies are not monitored. Please contact your administrator for any further support.</small>
  `;

  return {
    subject,
    mailBody
  };
}

/** Compose the approval mail */
async function composeApprovalMail(approverEmail, workflowRequest, taskToken) {
  const { 
    tenantId, accountId, region,
    requester, resourceType, workflowRequestId, requestReason,
    requestBundle, 
    requestVPC, requestSubnet, requestSecurityGroups,
    requestImage, requestInstanceType, requestKeyPair, 
  } = workflowRequest;
  const subject = `Exostack Workflow Approval Request - ${workflowRequestId}`;
  const [approvalLink, rejectionLink] = createApprovalLinks(workflowRequestId, taskToken);

  const linksValidTill = getLinksValidity();
  // const { given_name, family_name } = user.getUserRecord(approverEmail);

  cloudsController.init({tenantId});
  const cloud = await cloudsController.getCloud(accountId);
  const { price } = await computePricing(resourceType, cloud, region, { requestBundle, requestInstanceType, requestImage });
  console.log(`: composeApprovalMail -> price`, price);
  const priceDisplay = price ? `USD ${price}/Month` : '-- NA --';

  const resourceContent = (resourceType) => {
    switch (resourceType) {
      case validResourceTypes.WorkSpaces:
        return `Workspaces Bundle : ${requestBundle}`;

      case validResourceTypes.EC2:
        const consoleLinks = {
          ami    : `https://console.aws.amazon.com/ec2/v2/home?region=${region}#Images:visibility=public-images;imageId=${requestImage};sort=name`,
          keypair: `https://console.aws.amazon.com/ec2/v2/home?region=${region}#KeyPairs:keyName=${requestKeyPair};sort=keyName`,
          vpc    : `https://console.aws.amazon.com/vpc/home?region=${region}#vpcs:VpcId=${requestVPC};sort=VpcId`,
          subnet : `https://console.aws.amazon.com/vpc/home?region=${region}#subnets:SubnetId=${requestSubnet};sort=tag:Name`,
          secgrp : `https://console.aws.amazon.com/vpc/home?region=${region}#SecurityGroups:groupId=${requestSecurityGroups && requestSecurityGroups.join(',')};sort=groupId`,
        };
        return `EC2 Instance: 
      <ul>
        <li>Instance Type: ${requestInstanceType}</li>
        <li>AMI: <a href="${consoleLinks.ami}">${requestImage}</a></li>
        <li>VPC: <a href="${consoleLinks.vpc}">${requestVPC}</a></li>
        <li>Subnet: <a href="${consoleLinks.subnet}">${requestSubnet}</a></li>
        <li>Security Groups: <a href="${consoleLinks.secgrp}">${requestSecurityGroups}</a></li>
        <li>Key Pair: ${!!requestKeyPair ? `<a href="${consoleLinks.keypair}">${requestKeyPair}</a>` : 'None'}</li>
      </ul>`;

      default:
        return `Invalid resource type!`;
    }
  };

  const mailBody = `Hey ${approverEmail || ''}, <br/><br/>

  <span>Please review the below request for launching new AWS ${resourceType} resources using the Exostack Self-Service Portal - </span>

  <ul>
    <li> Request ID : ${workflowRequestId}</li>
    <li> Requester : ${requester}</li>
    <li> Account : ${accountId}</li>
    <li> Region : ${region}</li>
    <li> Resource : 
      ${resourceContent(resourceType)} 
    </li>
    <li> Estimated Cost: ${priceDisplay} <br/> <small> ** Note: excludes cost of any additional volumes requested! ** </small></li>
    <li> Justification: ${requestReason}</li>
  </ul>

    To approve this request, click ${approvalLink} <br/>
    To reject this request, click ${rejectionLink} <br/>
    
    <br/>
    
    These links are only usable once and valid till ${linksValidTill.toUTCString()}.<br/><br/>

    Thanks! <br/>
    Exostack Team

    <br/><br/>
    <small>Note - This is an automated email and replies are not monitored. Please contact your administrator for any further support.</small>
  `;

  return {
    subject,
    mailBody
  };
}

/** Handler for responding to approvals */
async function handleApprovalResponse(action, responseToken, requestId) {
  console.log('handleApprovalResponse', 'action', action, 'responseToken', responseToken);
  try {
    const decodedToken = decodeURIComponent(responseToken);
    console.log('decodedToken', decodedToken);
    await stepFunc.sendTaskSuccess({
      taskToken: decodedToken,
      output: JSON.stringify({ Approved: action === 'approve' })
    }).promise();

    return html({
      htmlBody: `<h5>Thank you for your response! (${action} - ${requestId})</h5>`,
      injectAutoClose: true
    });
  } catch (err) {
    console.error(err);
    return html({
      htmlBody: `<h5>Oops! Something went wrong recording your approval response.</h5>
      <br/>
      <span>Please contact your admin for support. ${err.code}</span>`,
      injectAutoClose: true 
    });
  }
}

const allowedApprovalOptions = [
  'approve-all',
  'approve-minx',
  'reject-single'
];

/** Handler for launch resource Task */
async function launchResource(event) {
  console.log(`: launchResource -> event`, event);
  const isManualApprovalFromParallel = Array.isArray(event);
  let launchRequest;
  if (!isManualApprovalFromParallel && event.AutoApproved) {
    console.log(`Request is auto-approved. Attempting for launch.`);
    launchRequest = event;
  } else {
    launchRequest = event[0];
    console.log(`Request requires Manual approvals. Checking approvals...`);
    const approvals = event.filter(approval => approval.outcome.Approved === true);
    const approvalsCount = approvals.length;
    if (approvalsCount === 0) { // more complex logic TODO
      const requestRejected = `Approval policy denies launching of requested resource.`;
      console.log(requestRejected, approvalsCount);
      return { 
        launchRequest,
        launchResult: { ResourceLaunched: false, Reason: requestRejected, LaunchDetails: `Total approvals: ${approvalsCount}` }
      };
    }
    launchRequest = approvals[0];
    console.log(`Request has ${approvalsCount} approvals.  Attempting for launch.`, launchRequest);
  }
  const { resourceType, requester } = launchRequest;
  console.log('resourceType', resourceType, 'launchRequest', launchRequest, 'requester', requester);

  // const { userTags } = await user.getUserTags(requester);
  // const resourceTags = constructTags(userTags, launchRequest);
  const resourceTags = constructTags(launchRequest);
  
  let launchResult;
  switch(resourceType) {
    case validResourceTypes.EC2:
      launchResult = await launchEC2instance(launchRequest, resourceTags);
      break;

    case validResourceTypes.WorkSpaces:
      launchResult = await launchWorkspace(launchRequest, resourceTags);
      break;
    
    case otherResourceTypes.SubnetRouting:
      launchResult = await executeSubnetLease(launchRequest);
      break;

    default:
      launchResult = { ResourceLaunched: false, Reason: `Invalid resource type.`, LaunchDetails: `Resource type ${resourceType} not supported.` };
  }
  return { launchRequest, launchResult };
}

/** Creates the tags to be applied to launched resources */
function constructTags(launchRequest) {
  const { requester, workflowId, workflowName, workflowRequestId, userTags } = launchRequest;
  const userTagsObject = JSON.parse(userTags || '[]');
  console.log(`: constructTags -> userTags`, userTags, userTagsObject);

  const resourceTags = userTagsObject.map(ut => {
    return {
      Key: ut.Name.split(':')[1],
      Value: ut.Values[0]
    };
  });
  resourceTags.push(
    {
      Key: 'exostack:requester',
      Value: requester
    }, 
    {
      Key: 'exostack:workflow',
      Value: `${workflowId} - ${workflowName}`
    }, 
    {
      Key: 'exostack:workflowRequestId',
      Value: workflowRequestId
    });
  console.log('resourceTags', resourceTags);
  return resourceTags;
}

/** Compose the launch outcome mail */
function composeLaunchMail(launchRequest, launchResult) {
  console.log(`: composeLaunchMail -> launchRequest, launchResult`, launchRequest, launchResult);
  const { requester, resourceType, workflowRequestId } = launchRequest;
  const { ResourceLaunched, Reason, LaunchDetails } = launchResult;
  const subject = `Exostack Workflow Request - ${workflowRequestId}`;
  const mailBody = `Hey ${requester}, <br/><br/>
  
  We've attempted to fulfill your ${resourceType} resource request - ${workflowRequestId}. <br/><br/>
  ${ResourceLaunched 
    ? `<strong>The requested resource was launched successfully!</strong> <br/>
    Please note that it may sometimes take a few minutes before it becomes fully available for use. <br/> 
    <hr/>
    <small>
    - Details: ${JSON.stringify(LaunchDetails, null, 2)}
    </small>
    <hr/> 
    `
    : `Unfortunately, we've hit a snag. Please review the details below.  <br/> 
      <hr/>
      - Failure Reason - ${Reason} <br/>
      <small>
      - Details: ${JSON.stringify(LaunchDetails, null, 2)}
      </small>
      <hr/> 
      <br/>
      You may retry your request, or contact your administrator for support if the issue persists.`
  }
  <br/><br/>

  Thanks! <br/>
  Exostack Team

  <br/><br/>
  <small>Note - This is an automated email and replies are not monitored. Please contact your administrator for any further support.</small>

  `;

  return { requester, subject, mailBody };
}

/** Updates the status for the workflow request DDB record  */
async function updateWorkflowRequestStatus(launchRequest, launchResult, notificationSent) {
  const { workflowId, workflowRequestId } = launchRequest;
  const status = launchResult.ResourceLaunched ? `FULFILLED` : `FAILED`;
  await docClient.update({
    TableName: WorkflowsRequestsTableInfo.TableName,
    Key: {
      workflowId,
      workflowRequestId
    },
    UpdateExpression: 'SET workflowRequestStatus = :status, notificationSent =:notified, updatedAt = :now',
    ExpressionAttributeValues: {
      ':status': status,
      ':notified': notificationSent,
      ':now': new Date().toISOString()
    }
  }).promise();
}

/** Launches the requested WorkSpace */
async function launchWorkspace(workflowEventBody, resourceTags) {
  try {  
    console.log(`launchWorkspace -> workflowEventBody`, workflowEventBody);
    const { accountId, tenantId, region, requestBundle: bundleId, workspaceOptions:{runningMode, autoStopHours} = {}, requester } = workflowEventBody;
    console.log({ accountId, tenantId, region, bundleId, requester });
    cloudsController.init({ tenantId });
    const cloud = await cloudsController.getCloud(accountId);
    
    const { workspacesClient, message } = await getWorkspacesClient(cloud, region);
    if (!workspacesClient) {
      return { ResourceLaunched: false, Reason: message };
    }
    const { Directories } = await workspacesClient.describeWorkspaceDirectories().promise();
    console.log(`: launchWorkspace -> Directories `, JSON.stringify(Directories) );
    
    if (!Directories || Directories.length === 0) {
      const reason = `No Directory exists to launch requested Workspace.`;
      console.log(`: launchWorkspace -> reason`, reason);
      return { ResourceLaunched: false, Reason: reason };
    }
    
    // const [{ DirectoryId: dirId }] = Directories;
    const queryResults = await queryDirectory(cloud, region, Directories, requester);
    console.log(`: launchWorkspace -> queryResults`, queryResults);
    if (!queryResults) {
      return { ResourceLaunched: false, Reason: `Requester email (${requester}) does not exist in any registered WorkSpaces directories.` };
    }
    const { directory, foundUser } = queryResults;
    console.log(`: launchWorkspace -> { directory, foundUser }`, { directory, foundUser }, 'WS-username',  `${directory.DirectoryName}\\${foundUser.Username}`);
    if (!foundUser) {
      return { ResourceLaunched: false, Reason: `Requester email (${requester}) does not exist in any registered WorkSpaces directories.` };
    }
    const { PendingRequests, FailedRequests } = await workspacesClient.createWorkspaces({
      Workspaces: [ 
        {
          BundleId   : bundleId,
          DirectoryId: directory.DirectoryId,
          UserName   : `${directory.DirectoryName}\\${foundUser.Username}`,   // 'corp.amazonworkspaces.com\\lalitr' // requester
          Tags       : resourceTags,
        //   RootVolumeEncryptionEnabled: true || false,
        //   UserVolumeEncryptionEnabled: true || false,
        //   VolumeEncryptionKey: 'STRING_VALUE',
          WorkspaceProperties: {
            RunningMode: runningMode === 'runningmode-autostop' ? 'AUTO_STOP' : 'ALWAYS_ON',
            RunningModeAutoStopTimeoutInMinutes: runningMode === 'runningmode-autostop' ? (autoStopHours || 1) * 60 : undefined,
        //     ComputeTypeName: VALUE | STANDARD | PERFORMANCE | POWER | GRAPHICS | POWERPRO | GRAPHICSPRO,
        //     RootVolumeSizeGib: 'NUMBER_VALUE',
        //     UserVolumeSizeGib: 'NUMBER_VALUE'
          }
        },
        /* more items */
      ]
    }).promise();
    console.log(`FailedRequests`, FailedRequests, `PendingRequests`, PendingRequests);
    if (FailedRequests && FailedRequests.length > 0) {
      return { ResourceLaunched: false, Reason: `WorkSpaces launch failed`, LaunchDetails: FailedRequests };
    }
    return { ResourceLaunched: true, Reason: `All OK`, LaunchDetails: PendingRequests };
  } catch (err) {
    console.error(JSON.stringify(err));
    return { ResourceLaunched: false, Reason: `Error occured during launch. ${err.message}` };
  }

}

/** Constructs a WorkDocs client object */
async function getWorkDocsClient(cloud, region) {
  const message = WORKDOCS_NOT_SUPPORTED;
  try {
    const workdocsClient = await clientManager.getEc2Client({ cloud, region, service: 'WorkDocs' });
    return { workdocsClient, message };
  } catch (wdErr) {
    console.error('getWorkDocsClient - wdErr: ', JSON.stringify(wdErr));
    if (wdErr.code === 'UnknownEndpoint') {
      return { message };
    }
    return { message: wdErr.message };
  }
}

/** Queries the WorkSpaces directories to resolve user email to userName */
async function queryDirectory(cloud, region, directories, userEmail) {
  console.log(`: queryDirectory -> cloud, region, directories, userEmail`, cloud, region, directories, userEmail);
  try {     
    const { workdocsClient, message } = await getWorkDocsClient(cloud, region);
    for (const directory of directories) {
      let nextToken = null;
      do {
        let nextUsers;
        ({ Users: nextUsers, Marker: nextToken } = await workdocsClient.describeUsers({
          OrganizationId: directory.DirectoryId,
          Include: 'ACTIVE_PENDING',
          Marker: nextToken
        }).promise());

        const foundUser = nextUsers.find(u => u.EmailAddress === userEmail);
        if (foundUser) {
          return {
            directory, 
            foundUser
          };
        }

      } while (nextToken !== null);
    }
  } catch (err) {
    console.error(err);
    return null;
  }

}

/** Launches the requested WorkSpace */
async function launchEC2instance(workflowEventBody, instanceTags) {
  try {    
    console.log(`launchEC2instance -> workflowEventBody`, workflowEventBody);

    const { 
      accountId, tenantId, region, resourceType,
      requester, workflowRequestId, workflowName,
      requestVPC, requestSubnet, requestSecurityGroups,
      requestImage, requestInstanceType, requestKeyPair,
      storageOptions: {
        deleteOnTermination,
        encrypt,
        key
      }, 
      addedVolumes,
      leaseOptions
    } = workflowEventBody;
    cloudsController.init({ tenantId });
    const cloud = await cloudsController.getCloud(accountId);

    const ec2Client = await clientManager.getEc2Client({ cloud, region, service: 'EC2' });
    const { Images: [{ BlockDeviceMappings, Architecture, Platform, HypervisorType }]} = await ec2Client.describeImages({
      ImageIds: [requestImage],
    }).promise();
    // BlockDeviceMappings[0].Ebs.VolumeSize = 15;
    BlockDeviceMappings.push(...addedVolumes.map(({ deviceName, volumeType, size, iops }) => {
        return {
          DeviceName: deviceName,
          Ebs: {
            VolumeType: volumeType,
            VolumeSize: size,
            Iops      : volumeType === 'io1' ? iops : undefined,
            DeleteOnTermination: deleteOnTermination,
            // Encrypted: true || false,
            // KmsKeyId: 'STRING_VALUE',
            // SnapshotId: 'STRING_VALUE',
            }
        }
      }));
      console.log(`addedVolumes`, addedVolumes);
      console.log(`BlockDeviceMappings`, JSON.stringify(BlockDeviceMappings));
    const instances = await ec2Client.runInstances({
      ClientToken : workflowRequestId,
      ImageId: requestImage,
      InstanceType: requestInstanceType,
      KeyName: requestKeyPair || null,
      MaxCount: 1,
      MinCount: 1,
      BlockDeviceMappings: BlockDeviceMappings,
      // [
      //   {
      //     DeviceName: '/dev/sda1',
      //     Ebs: {
      //       DeleteOnTermination: true, // || false,
      //       // Encrypted: true || false,
      //       // Iops: 'NUMBER_VALUE',
      //       // KmsKeyId: 'STRING_VALUE',
      //       // SnapshotId: 'STRING_VALUE',
      //       VolumeSize: '15',
      //       // VolumeType: standard | io1 | gp2 | sc1 | st1
      //     },
      //     // NoDevice: 'STRING_VALUE',
      //     // VirtualName: 'STRING_VALUE'
      //   },
      //   /* more items */
      // ],
      // SecurityGroupIds: requestSecurityGroups,
      // SubnetId: requestSubnet,
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          AssociatePublicIpAddress: true,
          Groups: requestSecurityGroups,
          SubnetId: requestSubnet,
        }
      ],
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: instanceTags
        },
        {
          ResourceType: 'volume',
          Tags: instanceTags
        }
      ]
    }).promise();

    if (leaseOptions && leaseOptions.applyLease) {
      console.log(`setting up leaseOptions record`, JSON.stringify(leaseOptions));
      const { Instances: [{ InstanceId: instanceId }] } = instances;
      const termination = { workflowRequestId, instanceId, requester, resourceType };
      await scheduleExpiration({ 
        tenantId, accountId, region, 
        objectKey: instanceId, 
        leaseOptions, 
        additionalInfo: termination 
      });
    }

    return { ResourceLaunched: true, Reason: `All OK`, LaunchDetails: instances };

  } catch (err) {
    console.error(err);
    return { ResourceLaunched: false, Reason: `Error occured during launch. ${err.message}`, LaunchDetails: err.message };
  }
}

const RoutingController = require('./routing');
const routingController = new RoutingController();

const VpnController = require('./vpnaccess');
const vpnController = new VpnController();

async function executeSubnetLease(launchRequest) {
  try {
    console.log(`:: executeSubnetLease -> launchRequest`, launchRequest);
    const {
      tenantId, accountId, region, instanceId, 
      resourceType, requester, workflowRequestId,
      leaseOptions,
      whitelist: { ipAddress, port }
    } = launchRequest;

    cloudsController.init({ tenantId });
    const cloud = await cloudsController.getCloud(accountId);

    let result, launchMessage, failMessage;
    result = await executeStartOfLeaseAction({ cloud, region, instanceId, leaseOptions });

    await whitelistAction(cloud, region, requester, ipAddress, instanceId, port);

    // schedule the end of lease action
    result = await scheduleExpiration({ 
      tenantId, accountId, region, objectKey: instanceId, 
      leaseOptions, 
      additionalInfo: { requester, resourceType, workflowRequestId } 
    });

    return { ResourceLaunched: result, Reason: `All OK`, LaunchDetails: 'Subnet access updated successfully.' };

  } catch (err) {
    console.error(err);
    return { ResourceLaunched: false, Reason: `Error updating subnet lease:${err.message}`, LaunchDetails: err.message };
  }
}

async function whitelistAction(cloud, region, requester, ipAddress, instanceId, port) {
  try {
    await vpnController.init({ cloud, region });
    const vpnMessage = await vpnController.allowUserAccess(requester, requester, ipAddress, instanceId, port);
    console.log(`:: executeSubnetLease -> vpnMessage`, vpnMessage);
    return vpnMessage;
  } catch (err) {
    console.error(`whitelistAction -> err`, err);
    return `Error setting up whitelist security groups for instance ${instanceId}, IP: ${ipAddress}, port: ${port}, requester: ${requester}`;
  }
}

async function executeStartOfLeaseAction({cloud, region, instanceId, leaseOptions}) {
  console.log(`:: executeStartOfLeaseAction -> instanceId, leaseOptions`, instanceId, leaseOptions);
  let result;
  try {
    await routingController.init({ cloud, region });
    // start of lease action?
    if (leaseOptions.leaseAction === 'public') {
      result = await routingController.createInternetRoute({ instanceId });
    }
    else if (leaseOptions.leaseAction === 'private') {
      result = await routingController.deleteInternetRoute({ instanceId });
    }
    return result;
  } catch (err) {
    result = false;
    console.error(err);
  }
  return result;
}
