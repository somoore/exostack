'use strict';

/*
REFERENCES:
  - https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html
  - https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html?shortFooter=true#vpc-limits-security-groups
*/

const isIp = require('is-ip');

// load config values from environment variables
// use defaults where env.vars are not provided
const {
  protocol = 'tcp',
  durationHours = 1,
  MAX_INGRESS_RULES_PER_SG = 60,
  TagNameVPNWhitelistSG,
  TagNameVPNWhitelistSGInstance
} = process.env;

const {
  getDescription,
  parseDescription
} = require("./utils");

const IpRangeTypes = {
  v4: 'IpRanges',
  v6: 'Ipv6Ranges'
}

const Ec2ClientManager = require('./ec2Client');
const ec2Mgr = new Ec2ClientManager();

module.exports = class VpnController {

  async init({cloud, region}) {
    this.cloud = cloud;
    this.region = region;
    this.ec2 = await ec2Mgr.getEc2Client({cloud, region});
  }

  /**
   * Enables VPN access for a given user (identified by an API key) and their IP address
   * @param {string} userKey the API Key (or other user identifier)
   * @param {string} ipAddress the IP address that needs to be allowed VPN access
   */
  async allowUserAccess(username, userKey, ipAddress, instanceId, port) {

    // ec2 = getEc2Client(region);

    // validate IP address format
    const isIPv6 = isIp.v6(ipAddress);
    const isIPv4 = isIp.v4(ipAddress);

    if (!isIPv6 && !isIPv4) {
      throw new Error(`The IP Address string provided (${ipAddress}) has an invalid format.`);
    }

    // get a handle to the correct SG to be used for adding a new ingress rule
    const whitelistSG = await this.getWhitelistSG(instanceId, isIPv4 ? IpRangeTypes.v4 : IpRangeTypes.v6);

    // ensure association of the new or existing SG with the VPN EC2 instance.
    // NOTE: Max allowed SGs per network interface is default 5
    const sgAssociated = await this.associateInstanceSG(instanceId, whitelistSG.GroupId);
    console.log(sgAssociated);

    // construct a Description for the new ingress rule
    const description = getDescription(username, userKey, ipAddress, durationHours);

    // construct and submit the request for authorizing the ingress rule
    let ipRange
    if (isIPv4) {
      ipRange = [{
        CidrIp: `${ipAddress}/32`,
        Description: description
      }];
    } else if (isIPv6) {
      ipRange = [{
        CidrIpv6: `${ipAddress}/128`,
        Description: description
      }];
    } 
    const ingressRuleAdded = await this.ec2.authorizeSecurityGroupIngress({
      GroupId: whitelistSG.GroupId,
      IpPermissions: [{
        FromPort  : port,
        ToPort    : port,
        IpProtocol: protocol,
        IpRanges  : isIPv4 ? ipRange : null,
        Ipv6Ranges: isIPv6 ? ipRange : null,
      }]
    }).promise()
    .then(_ => {
        return `Successfully created the requested VPN whitelist ingress rule. [Instance ${instanceId} | IP ${ipAddress} | port ${port}]`;
    })
    .catch(err => {
      console.error(err.message);
      if (err.code === 'InvalidPermission.Duplicate') {
        const message = `Ingress access has previously been granted. (Requested ingress rule already exists)`;
        console.log(message);
        return message;
      }
      throw err;
    });

    console.log(`:: REVOKING INTERNET ACCESS`);
    const egressInternetRevoke = await this.ec2.revokeSecurityGroupEgress({
      GroupId: whitelistSG.GroupId,
      IpPermissions: [{
        FromPort  : 0,
        ToPort    : 65535,
        IpProtocol: '-1',
        IpRanges  : [{ CidrIp: '0.0.0.0/0' }],
        Ipv6Ranges: null,
      }]
    }).promise();
    console.log(`:: allowUserAccess -> egressInternetRevoke`, egressInternetRevoke);

    const egressRuleAdded = await this.ec2.authorizeSecurityGroupEgress({
      GroupId: whitelistSG.GroupId,
      IpPermissions: [{
        FromPort  : port,
        ToPort    : port,
        IpProtocol: protocol,
        IpRanges  : isIPv4 ? ipRange : null,
        Ipv6Ranges: isIPv6 ? ipRange : null,
      }]
    }).promise()
    .then(_ => {
        return `Successfully created the requested VPN whitelist egress rule. [Instance ${instanceId} | IP ${ipAddress} | port ${port}]`;
    })
    .catch(err => {
      console.error(err.message);
      if (err.code === 'InvalidPermission.Duplicate') {
        const message = `Egress access has previously been granted. (Requested egress rule already exists)`;
        console.log(message);
        return message;
      }
      throw err;
    });

    return `${ingressRuleAdded}\n${egressRuleAdded}`;
  };

  /**
   * Lists all the ingress rules configured for a userKey
   * @param {string} userKey user identifier
   */
  async listUserAccessRules(userKey = null) {
    let filter;
    if (userKey) {
      filter = (r) => {
        const { userKey: parsedKey } = parseDescription(r.Description);
        return (parsedKey === userKey);
      };
    } else {
      filter = (r) => true;
    }
    const {
      ipv4RangesFiltered,
      ipv6RangesFiltered
    } = await this.lookupAccessRules(filter, filter);
    const allRules = [] //;
    .concat(ipv4RangesFiltered
        .map(r => {return {
            from:r.FromPort, to:r.ToPort, protocol:r.IpProtocol, 
            IP:r.Cidr, InstanceId:r.InstanceId, 
            Description:r.Description , ...parseDescription(r.Description)
          };}))
    .concat(ipv6RangesFiltered
      .map(r => {return {
        from:r.FromPort, to:r.ToPort, protocol:r.IpProtocol, 
        IP:r.Cidr, InstanceId:r.InstanceId, 
        Description:r.Description , ...parseDescription(r.Description)
      };}))
    .sort((r1, r2) => r1.expiresAt - r2.expiresAt)
    .map(r => {
      return {
        "port": r.from === r.to ? r.from : `${r.from} - ${r.to}`,
        "ipAddress": r.ipAddress,
        "instanceId": r.InstanceId,
        "createdAt": new Date(Number(r.createdAt)).toISOString(),
        "expiresAt": new Date(Number(r.expiresAt)).toISOString(),
        "createdBy": r.username,
        "description": r.Description
      }
    })

    return allRules;
  }

  /**
   * Gets the list of ingress rules configured based on filter criteria provided
   * @param {Function} filterv4 filter function to apply on the IpRanges (v4) ruleset
   * @param {Function} filterV6 filter function to apply on the IpV6Ranges (v6) ruleset
   */
  async lookupAccessRules(filterv4, filterV6, instanceId = null) {

    // fetch all existing SGs for the VPC tagged as VPNWhitelistSG
    const { SecurityGroups: allSgs } = await this.getAllWhitelistSGs(instanceId);

    const ipv4RangesFiltered = [], ipv6RangesFiltered = [];
    for (const { GroupName, GroupId, IpPermissions, IpPermissionsEgress, Tags } of allSgs) {
      console.log(`Tags`, Tags, 'TagNameVPNWhitelistSGInstance', TagNameVPNWhitelistSGInstance);
      const instanceSGTag = Tags.find(t => t.Key === TagNameVPNWhitelistSGInstance);
      if (!instanceSGTag) {
        console.error(`[WARN]: Found SG without the expected tag '${TagNameVPNWhitelistSGInstance}'`, GroupName, GroupId, Tags,);
        continue;
      }
      const instanceSGTagValue = Tags.find(t => t.Key === TagNameVPNWhitelistSGInstance).Value
      console.log(`--- checking SG: ${GroupName} (${GroupId}) for INGRESS rules for instance (${instanceSGTagValue}).`);
      for (const { IpRanges, Ipv6Ranges, FromPort, ToPort, IpProtocol } of IpPermissions) {
        IpRanges
          .filter(filterv4)
          .forEach(r => ipv4RangesFiltered.push({ RuleType:'INGRESS', GroupId, FromPort, ToPort, IpProtocol, Cidr:r.CidrIp, Description:r.Description, [IpRangeTypes.v4]:r, InstanceId:instanceSGTagValue }));
        Ipv6Ranges
          .filter(filterV6)
          .forEach(r => ipv6RangesFiltered.push({ RuleType: 'INGRESS', GroupId, FromPort, ToPort, IpProtocol, Cidr:r.CidrIpv6, Description:r.Description, [IpRangeTypes.v6]:r, InstanceId:instanceSGTagValue }));
        console.log('INGRESS', ipv4RangesFiltered.length, ipv6RangesFiltered.length);
      }

      console.log(`--- checking SG: ${GroupName} (${GroupId}) for EGRESS rules for instance (${instanceSGTagValue}).`);
      for (const { IpRanges, Ipv6Ranges, FromPort, ToPort, IpProtocol } of IpPermissionsEgress) {
        IpRanges
          .filter(filterv4)
          .forEach(r => ipv4RangesFiltered.push({ RuleType: 'EGRESS', GroupId, FromPort, ToPort, IpProtocol, Cidr:r.CidrIp, Description:r.Description, [IpRangeTypes.v4]:r, InstanceId:instanceSGTagValue }));
        Ipv6Ranges
          .filter(filterV6)
          .forEach(r => ipv6RangesFiltered.push({ RuleType: 'EGRESS', GroupId, FromPort, ToPort, IpProtocol, Cidr:r.CidrIpv6, Description:r.Description, [IpRangeTypes.v6]:r, InstanceId:instanceSGTagValue }));
        console.log('EGRESS', ipv4RangesFiltered.length, ipv6RangesFiltered.length);
      }
    }
    // console.log(ipv4RangesFiltered, ipv6RangesFiltered);
    return { ipv4RangesFiltered, ipv6RangesFiltered };
  }

  async revokeByFilter(filter, revokeIp, instanceId) {
    const noFilter = () => false;
    
    if (isIp.v4(revokeIp)) { // single IP v4
      const { ipv4RangesFiltered } = await this.lookupAccessRules(filter, noFilter, instanceId);
      await this.revokeIngressRules(IpRangeTypes.v4, ipv4RangesFiltered);
      await this.revokeEgressRules(IpRangeTypes.v4, ipv4RangesFiltered);

    } else if (isIp.v6(revokeIp)) { // single IP v6
      const { ipv6RangesFiltered } = await this.lookupAccessRules(noFilter, filter, instanceId);
      await this.revokeIngressRules(IpRangeTypes.v6, ipv6RangesFiltered);
      await this.revokeEgressRules(IpRangeTypes.v6, ipv6RangesFiltered);

    } else if (!revokeIp) { // no IP provided (cleanup all)
      const {
        ipv4RangesFiltered,
        ipv6RangesFiltered
      } = await this.lookupAccessRules(filter, filter);
      await this.revokeIngressRules(IpRangeTypes.v4, ipv4RangesFiltered);
      await this.revokeIngressRules(IpRangeTypes.v6, ipv6RangesFiltered);
      await this.revokeEgressRules(IpRangeTypes.v4, ipv4RangesFiltered);
      await this.revokeEgressRules(IpRangeTypes.v6, ipv6RangesFiltered);
      return `Request Access revoked: ${revokeIp} | ${instanceId}`;

    } else { //invalid IP
      throw new Error(`The IP Address string provided (${revokeIp}) has an invalid format.`);
    }
  }

  /**
   * Revokes the VPN ingress rule for a single userKey and IP Address
   * @param {*} revokeUserKey the userKey to be revoked
   * @param {*} revokeIp the IP address to be revoked
   * @param {*} instanceId Instance identifer
   */
  async revokeUserAccess(revokeUserKey, revokeIp, instanceId) {
    const filter = (r) => {
      const { ipAddress, userKey } = parseDescription(r.Description);
      if (!revokeIp) {
        return (revokeUserKey === userKey);
      }
      return (revokeIp === ipAddress && revokeUserKey === userKey);
    };
    await this.revokeByFilter(filter, revokeIp, instanceId);
    return `All access revoked for User Key: ${revokeUserKey} to instance: ${instanceId} ${ revokeIp ? ' from IP :' + revokeIp : ''}`;
  }

  /**
   * Deletes a single ingress rule based on description field provided
   * @param {string} description Description field for the target ingress rule
   * @param {string} instanceId Instance identifer
   */
  async revokeByDescription(description, ipAddress, instanceId) {
    const filter = (r) => {
      return (r.Description === description);
    }
    await this.revokeByFilter(filter, ipAddress, instanceId);
    return `Requested ingress rule has been deleted.`;
  }

  /**
   * Performs a cleanup of all expired VPN ingress rules across all tagged SGs 
   */
  async revokeExpiredAccessRules() {
    // lookup all ingress rules by using an expiration filter
    const expirationFilter = (r) => (parseDescription(r.Description).expired === true);
    const {
      ipv4RangesFiltered: ipv4RangesExpired,
      ipv6RangesFiltered: ipv6RangesExpired
    } = await this.lookupAccessRules(expirationFilter, expirationFilter);

    // execute the cleanup for both IPv4 and IPv6 buckets
    await this.revokeIngressRules(IpRangeTypes.v4, ipv4RangesExpired);
    await this.revokeIngressRules(IpRangeTypes.v6, ipv6RangesExpired);
  }

  /**
   * Revokes a set of VPN ingress rules of a particular type
   * @param {v4|v6} ipRangeType Type of the IP (changes the bucket to address)
   * @param {*} ipRanges set of ingress rules of the specified type
   */
  async revokeIngressRules(ipRangeType = IpRangeTypes.v4, ipRanges) {
    console.log(`Revoking ${ipRanges.length} (${ipRangeType}) ingress rules`); //, expiredRanges);
    for (const rule of ipRanges.filter(r => r.RuleType === 'INGRESS')) {
      // console.log(rule);
      await this.ec2.revokeSecurityGroupIngress({
        GroupId: rule.GroupId,
        IpPermissions: [{
          FromPort     : rule.FromPort,
          ToPort       : rule.ToPort,
          IpProtocol   : rule.IpProtocol,
          [ipRangeType]: [rule[ipRangeType]]
        }]
      }).promise();
    }
  }

  /**
   * Revokes a set of VPN Egress rules of a particular type
   * @param {v4|v6} ipRangeType Type of the IP (changes the bucket to address)
   * @param {*} ipAddress IP Address of egress rules of the specified type
   */
  async revokeEgressRules(ipRangeType = IpRangeTypes.v4, ipRanges) {
    const egressRanges = ipRanges.filter(r => r.RuleType === 'EGRESS');
    console.log(`Revoking ${egressRanges.length} (${ipRangeType}) egress rules`); //, expiredRanges);
    for (const rule of egressRanges) {
      console.log(rule);
      await this.ec2.revokeSecurityGroupEgress({
        GroupId: rule.GroupId,
        IpPermissions: [{
          FromPort     : rule.FromPort,
          ToPort       : rule.ToPort,
          IpProtocol   : rule.IpProtocol,
          [ipRangeType]: [rule[ipRangeType]]
        }]
      }).promise();
    }
  }

  /**
   * Gets the Security Group to hold the new Ingress rule
   * Checks existing groups that have an available slot
   * If none exist, then creates a new one
   * @param {boolean} ipRangeType type of IP address for the new ingress rule
   */
  async getWhitelistSG(instanceId, ipRangeType = IpRangeTypes.v4) {

    // fetch all existing SGs for the VPC tagged as VPNWhitelistSG
    const { SecurityGroups: allSecGroups } = await this.getAllWhitelistSGs(instanceId);

    // if none exists, create a new one and use it
    if (allSecGroups.length === 0) {
      console.log(`No VPN Whitelist Security Group exists for instance (${instanceId}). Attempting to create a new one...`);
      return await this.createWhitelistSG(instanceId);
    }

    // if SGs already exist, check each one for the rule count
    for (const sg of allSecGroups) {
      const ingressRulesCount = sg.IpPermissions
          .map(perm => perm[ipRangeType].length)
          .reduce((prev, curr) => prev + curr, 0);

      if (ingressRulesCount < MAX_INGRESS_RULES_PER_SG) {
        console.log(`Found an existing VPN whitelist SG (${sg.GroupName}) having ${ingressRulesCount} ingress rules:`);
        return sg;
      }
    }

    // all the existing SGs already have maximum allowable rules
    // so create a new SG and use it
    console.log(`Checked all existing VPN Whitelist SGs but found none with spare ingress rule slots. Attempting to create a new one...`);
    return await this.createWhitelistSG(instanceId);
  }

  /**
   * Queries for all SGs in the VPC that are tagged as VPN
   * Optionally filters SGs for single instance if instanceId is provided
   */
  async getAllWhitelistSGs(instanceId = null) {
    const filters = [
      // {
      //   Name: 'vpc-id',
      //   Values: [vpcId]
      // },
      {
        Name: `tag-key`,
        Values: [`${TagNameVPNWhitelistSGInstance}`]
      }
    ];
    if (instanceId) {
      filters.push({
        Name: `tag:${TagNameVPNWhitelistSGInstance}`,
        Values: [instanceId]
      });
    }
    return await this.ec2.describeSecurityGroups({
      Filters: filters
    }).promise();
  }

  /**
   * Creates a new Security Group to be used for whitelisting VPN access
   *  Tags the new SG and assigns it to the VPN EC2 instance
   */
  async createWhitelistSG(instanceId) {

    const creationTime = new Date();
    const groupName = `${TagNameVPNWhitelistSG}-${instanceId}-${creationTime.valueOf()}`;

    // TODO: revisit -
    const InstanceManager = require("./instance");
    const instanceManager = new InstanceManager();
    await instanceManager.init({cloud:this.cloud, region:this.region});
    const [{ vpcId }] = await instanceManager.getInstanceInfo({instanceId, region: this.ec2.config.region});

    const newWhitelistSG = await this.ec2.createSecurityGroup({
      VpcId: vpcId,
      GroupName: groupName,
      Description: `VPN Whitelist Security Group for instance ${instanceId} (created @ ${creationTime.toLocaleString()})`
    }).promise();
    console.log(`Created new VPN Whitelist Security Group in vpc ${vpcId} for instance ${instanceId}: Name: ${groupName} | Id: ${newWhitelistSG.GroupId}`);

    // tag the newly created SG so that it can be looked up
    const tagsCreated = await this.ec2.createTags({
      Resources: [newWhitelistSG.GroupId],
      Tags: [
      // {
      //   Key: TagNameVPNWhitelistSG,
      //   Value: 'true'
      // },
      {
        Key: TagNameVPNWhitelistSGInstance,
        Value: instanceId
      }
    ]
    }).promise();
    console.log(`Tagged the new SG: ${TagNameVPNWhitelistSGInstance}:${instanceId}`);
    
    return newWhitelistSG;
  }

  /**
   * Associate an instance with a security group
   * @param {string} instanceId Instance ID 
   * @param {string} secGroupId Security group ID
   */
  async associateInstanceSG(instanceId, secGroupId) {
    // get the list of SGs already associated with the instance
    const {
      Groups: existingGroups
    } = await this.ec2.describeInstanceAttribute({
      InstanceId: instanceId,
      Attribute: 'groupSet'
    }).promise();

    if (existingGroups.includes(secGroupId)) {
      return `Instance (${instanceId}) and SG (${secGroupId}) association already exists`;

    } else {
      // associate the new SG with the instance
      const sgAssociated = await this.ec2.modifyInstanceAttribute({
        InstanceId: instanceId,
        Groups: [...existingGroups.map(g => g.GroupId), secGroupId]
      }).promise()
        .then(_ => {
          return `Associated the new VPN whitelist SG (${secGroupId}) with the VPN instance (${instanceId})`;
        })
        .catch(err => {
          if (err.code === 'SecurityGroupsPerInstanceLimitExceeded') {
            return `Unable to associate the SG (${secGroupId}) with the VPN instance (${instanceId}). Limit exceeded.`;
          }
          throw err;
        });
      return sgAssociated;
    }
  }
}
