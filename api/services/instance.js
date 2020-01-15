'use strict';

const Ec2ClientManager = require('./ec2Client');
const ec2Mgr = new Ec2ClientManager();

const { querySchedule } = require('./scheduler');

module.exports = class InstanceController {
  
  async init({cloud, region}) {
    this.ec2 = await ec2Mgr.getEc2Client({cloud, region, service: 'EC2'});
  }

  /**
   * gets a list of available EC2 regions
   */
  async getEc2Regions() {
    console.assert(typeof this.ec2 !== 'undefined', 'EC2 NOT INITIALIZED');
    const allEc2Regions = await this.ec2.describeRegions().promise();
    return allEc2Regions.Regions.map(r => r.RegionName).sort((r1,r2) => r1 > r2 ? -1 : 1);
  }

  /**
   * Gets info for instance(s) that is tagged as the VPN
   * If instanceId is provided, then filters down to a single instance
   * Otherwise, uses a pre-defined tag name to get the list of instances in a VPC
   */
  async getInstanceInfo({ instanceId, region, userTags, tenantId, accountId, includeRoutingDetails = false}) {
    console.log(`:: getInstanceInfo -> includeRoutingDetails`, includeRoutingDetails);
    try {
      console.log(`Fetching instances`, {instanceId, region, userTags});
      let describeRequest = {};

      if (instanceId) {
        describeRequest = {
          InstanceIds: [instanceId]
        };
      } else if (userTags) {
        const filterUserTags = JSON.parse(userTags);
        if (filterUserTags && Array.isArray(filterUserTags) && filterUserTags.length > 0) {
          describeRequest = {
            Filters: filterUserTags
          };
        }
      }

      const vpnInstances = await this.ec2.describeInstances(describeRequest).promise();
      const instances = [].concat(...vpnInstances.Reservations
        .map(r => r.Instances
          .map(i => {
            const nameTag = i.Tags.find(t => t.Key === 'Name');
            return {
              instanceType    : i.InstanceType,
              instanceId      : i.InstanceId,
              platform        : i.Platform || 'linux',
              state           : i.State && i.State.Name,
              stateReason     : i.StateReason && i.StateReason.Message,
              publicIpV4      : i.PublicIpAddress,
              publicDNS       : i.PublicDnsName,
              privateIp       : i.PrivateIpAddress,
              nameTag         : nameTag && nameTag.Value,
              vpcId           : i.VpcId,                                  //used for setting VPN access (SG creation)
              subnetId        : i.SubnetId,
              availabilityZone: i.Placement.AvailabilityZone,
              launchTime      : i.LaunchTime
            }
          })
        ));

      if (includeRoutingDetails) {
        const instancesInfoSchedules = await Promise.all(instances.map(async (instanceInfo) => {
          const { instanceId } = instanceInfo;
          try {
            const schedule = await querySchedule({ tenantId, accountId, region, objectKey: instanceId, resourceType: 'SubnetRouting' });
            console.log(`:: schedule`, schedule);
            return { ...instanceInfo, schedule };
          } catch (err) {
            console.error(`Unable to retrive subnet routing schedule for instance ${instanceId}`, err);
            return instanceInfo;
          }
        }));
        return instancesInfoSchedules;
      }
      return instances;
    } catch (err) {
      console.error(err.message);
      throw err;
    }
  }

  /**
   * Reboots a running instance
   * @param {string} instanceId 
   */
  async rebootInstance({instanceId, region}) {
    try {
      console.log(`requesting reboot for instance: ${instanceId}`);
      const rebootRequest = await this.ec2.rebootInstances({
        InstanceIds: [instanceId],
      }).promise();
      return rebootRequest && `Rebooting the running instance ${instanceId}`;
    } catch (e) {
      console.error(e.message);
      return e.message;
    }
  }

  /**
   * Starts a stopped instance
   * @param {string} instanceId 
   */
  async startInstance({instanceId, region}) {
    try {
      console.log(`requesting start for instance: ${instanceId}`);
      const startRequest = await this.ec2.startInstances({
        InstanceIds: [instanceId]
      }).promise();
      const starting = startRequest.StartingInstances.find(i => i.InstanceId === instanceId);
      return this._reportInstanceStateChange(instanceId, starting);
    } catch (e) {
      console.error(e.message);
      return e.message;
    }
  }

  /**
   * Stops a running instance
   * @param {string} instanceId 
   */
  async stopInstance({instanceId, region}) {
    try {
      console.log(`requesting stop for instance: ${instanceId}`);
      const stopRequest = await this.ec2.stopInstances({
        InstanceIds: [instanceId],
        // Force: true,
        // Hibernate: true
      }).promise();
      const stopping = stopRequest.StoppingInstances.find(i => i.InstanceId === instanceId);
      return this._reportInstanceStateChange(instanceId, stopping);
    } catch (e) {
      console.error(e.message);
      return e.message;
    }
  }

  /**
   * Terminates an instance
   * @param {string} instanceId 
   */
  async terminateInstance({instanceId, region}) {
    try {
      console.log(`requesting termination for instance: ${instanceId}`);
      const terminateRequest = await this.ec2.terminateInstances({
        InstanceIds: [instanceId],
      }).promise();
      const stopping = terminateRequest.TerminatingInstances.find(i => i.InstanceId === instanceId);
      return this._reportInstanceStateChange(instanceId, stopping);
    } catch (e) {
      console.error(e.message);
      return e.message;
    }
  }

  _reportInstanceStateChange(instanceId, instanceStateChange) {
    let message;
    if (instanceStateChange.PreviousState.Name === instanceStateChange.CurrentState.Name) {
      message = `Instance state for ${instanceId} is already set as ${instanceStateChange.PreviousState.Name}`;
    }
    else {
      message = `Changing instance state for ${instanceId} from ${instanceStateChange.PreviousState.Name} to ${instanceStateChange.CurrentState.Name}`;
    }
    console.log(message);
    return message;
  }
    
  /**
   * Gets console output and screenshot for an instance
   * @param {string} instanceId 
   */
  async getInstanceConsole({instanceId, region}) {
    console.log(`requesting screenshot for instance: ${instanceId}`);
    try {
      // capture console output
      const { Output:consoleOut, Timestamp:timeStamp } = await this.ec2.getConsoleOutput({
        InstanceId: instanceId,
        // Latest: true
      }).promise();
      
      // capture console screenshot
      const { ImageData:consoleImageBase64 } = await this.ec2.getConsoleScreenshot({
        InstanceId: instanceId,
        WakeUp: true
      }).promise();
      
      console.log(`Captured console output`);

      return {
        consoleOut,
        timeStamp,
        consoleImageBase64
      };

    } catch (e) {
      console.error(e.message);
      throw e;
    }
  }
}
