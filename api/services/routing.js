'use strict';

const Ec2ClientManager = require('./ec2Client');
const ec2Mgr = new Ec2ClientManager();

const INTERNET = '0.0.0.0/0';

module.exports = class RoutingController {

    async init({ cloud, region }) {
        this.ec2 = await ec2Mgr.getEc2Client({ cloud, region, service: 'EC2' });
    }

    async getInstanceRouteTable({ instanceId }) {
        console.log(`:: getInstanceRouteTable -> instanceId`, instanceId);
        if (!instanceId) {
            throw new Error(`Required parameter instanceId missing.`, instanceId);
        }
        // try {
        // get the VPC for the instance
        const { VpcId, SubnetId } = await this.getVpcSubnet(instanceId);

        if (!VpcId || !SubnetId) {
            throw new Error(`Invalid VPC or Subnet for instance. The instance may be terminated.`);
        }
        // get IGW for the VPC
        const { InternetGatewayId } = await this.getVpcInternetGateway(VpcId);

        // get the route table for the instance subnet
        const { RouteTableId, IsMainRouteTable, HasInternetRoute } = await this.getRouteTable(VpcId, SubnetId);

        console.log(`getInstanceRouteTable -> instanceId, VpcId, SubnetId,
            RouteTableId, IsMainRouteTable,
            InternetGatewayId`, 
            instanceId, VpcId, SubnetId,
            RouteTableId, IsMainRouteTable,
            InternetGatewayId);

        return {
            instanceId, VpcId, SubnetId,
            RouteTableId, IsMainRouteTable,
            InternetGatewayId, VpcHasInternetGateway: !!InternetGatewayId, HasInternetRoute
        };

        // create a new route to the IGW, and report
        await createInternetRoute(RouteTableId, InternetGatewayId);
        await getRouteTable(VpcId, SubnetId);

        // delete the new route to the IGW, and report
        // await deleteInternetRoute(RouteTableId);
        // await getRouteTable(VpcId, SubnetId);

        // } catch (err) {
        //     console.error(`Oops! something went wrong!`, err.message);
        // }
    }

    async getVpcSubnet(instanceId) {
        const { Reservations: [{
            Instances: [{
                VpcId,
                SubnetId
            }]
        }] } = await this.ec2.describeInstances({
            InstanceIds: [instanceId]
        }).promise();
        console.log(`: VpcId, SubnetId => `, VpcId, SubnetId);
        return { VpcId, SubnetId };
    }

    async getVpcInternetGateway(VpcId) {
        const { InternetGateways: [{
            InternetGatewayId,
            Attachments: [{
                VpcId: igwVpcId,
                State
            } = {}] = []
        } = {}] = [] } = await this.ec2.describeInternetGateways({
            Filters: [{
                Name: "attachment.vpc-id",
                Values: [VpcId]
            }]
        }).promise();
        console.log(`: VpcId, InternetGatewayId => `, igwVpcId, InternetGatewayId);
        return { InternetGatewayId };
    }

    async getRouteTable(VpcId, SubnetId) {
        let routeTable, isMain = false;
        const associatedRouteTable = await this.ec2.describeRouteTables({
            Filters: [{
                Name: 'association.subnet-id',
                Values: [SubnetId]
            }]
        }).promise();
        if (associatedRouteTable.RouteTables.length > 0) {
            console.log(`: associatedRouteTable`, true);
            routeTable = associatedRouteTable;
            isMain = false;
        } else {
            const mainRouteTable = await this.ec2.describeRouteTables({
                Filters: [{
                    Name: 'association.main',
                    Values: ['true']
                },
                {
                    Name: 'vpc-id',
                    Values: [VpcId]
                }]
            }).promise();
            console.log(`: mainRouteTable`, true);
            routeTable = mainRouteTable;
            isMain = true;
        }
        // console.log(`: routeTable`, routeTable);
        const { RouteTables: [{
            RouteTableId,
            Routes
        } = {}] = [] } = routeTable;
        console.log(`: RouteTableId => `, RouteTableId);
        Routes.forEach(({ DestinationCidrBlock, GatewayId, State }) => {
            console.log(`\t ${DestinationCidrBlock}, ${GatewayId}, ${State}`);
        });
        const hasInternetRoute = Routes.some(route => route.DestinationCidrBlock === INTERNET);
        return {
            RouteTableId,
            IsMainRouteTable: isMain,
            HasInternetRoute: hasInternetRoute
        };
    }

    async createInternetRoute({ instanceId }) {
        console.log(`:: createInternetRoute -> instanceId`, instanceId);
        // try {
            const { RouteTableId, InternetGatewayId } = await this.getInstanceRouteTable({instanceId});
            console.log(`:: createInternetRoute -> RouteTableId, InternetGatewayId`, RouteTableId, InternetGatewayId);
            const { Return } = await this.ec2.createRoute({
                RouteTableId,
                DestinationCidrBlock: INTERNET,
                GatewayId: InternetGatewayId
            }).promise();
            console.log(Return ? `New route to IGW created!` : `Problem creating route to IGW`, Return);
            return Return;
        // } catch (err) {
        //     console.error(`Problem creating route to IGW`, err);
        //     return false;
        // }
    }

    async deleteInternetRoute({instanceId}) {
        console.log(`:: deleteInternetRoute -> instanceId`, instanceId);
        // try {
            const { RouteTableId } = await this.getInstanceRouteTable({instanceId});
            console.log(`:: deleteInternetRoute -> RouteTableId`, RouteTableId);
            await this.ec2.deleteRoute({
                RouteTableId,
                DestinationCidrBlock: INTERNET,
            }).promise();
            console.log(`Route to IGW deleted!`);
            return true;
        // } catch (err) {
        //     console.error(`Problem deleting route from IGW`, err);
        //     if (err.code === 'InvalidRoute.NotFound') {

        //     }
        //     return false;
        // }
    }
}
