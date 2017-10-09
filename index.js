module.exports = function(RED) 
{
    //variables placed here are shared by all nodes
    //var dimmable = false;

    function AlexaLocalNode(config) {
        RED.nodes.createNode(this, config);
        var thisNode = this;

        //Restore saved port number, if any

        //HTTP Server to host the Hue API (any port)
        var http = require('http');
        var httpServer = http.createServer(function(request, response){
            handleHueApiRequestFunction(request, response, thisNode, config);
        });
        httpServer.listen(0, function(error) {
            if (error) {
                thisNode.status({fill:"red", shape:"ring", text:"unable to start"});
                console.error(error);
                return;
            }

            var deviceName = "";
            if (config.devicename)
                deviceName = config.devicename;

            var port = httpServer.address().port;
            config.port = port;
            thisNode.status({fill:"green", shape:"dot", text:"online (p:" + port + ")"});
            console.log("[Alexa] " + deviceName + " is served on port %s", port);

            //Start discovery service after we know the port number            
            startSSDP(thisNode, port, config);
        });
    }

    //Start SSDP discovery service with the port discovered by HTTP server
    function startSSDP(thisNode, port, config)
    {
        //Sanity check
        if (port === null || port <= 0) {
            var errorMsg = "port is undefined";
            thisNode.status({fill:"red", shape:"ring", text:errorMsg});
            return;
        }

        var ssdp = require("peer-ssdp");
        var peer = ssdp.createPeer();
        peer.on("ready", function(){
        });
        peer.on("notify", function(headers, address){
        });
        peer.on("search", function(headers, address){
            //console.log("SEARCH:");
            //console.log(headers);
            //console.log(address);
            var isValid = headers.ST && headers.MAN=='"ssdp:discover"';
            if (!isValid)
                return;

            // {{networkInterfaceAddress}} will be replaced with the actual IP Address of
            // the corresponding network interface. 
            peer.reply({
                NT: "urn:schemas-upnp-org:device:basic:1",
                SERVER: "node.js/0.10.28 UPnP/1.1",
                ST: "urn:schemas-upnp-org:device:basic:1",
                USN: "uuid:Socket-1_0-221438K0100073::urn:Belkin:device:**",
                LOCATION: "http://{{networkInterfaceAddress}}:" + port + "/upnp/amazon-ha-bridge/setup.xml",
            }, address);
        });
        peer.on("found",function(headers, address){
            console.log("FOUND:", headers);
        });
        peer.on("close",function(){
            console.log("CLOSING.");
        });
        peer.start();
    }

    function constructAllLightsConfig(lightId, deviceName, httpPort)
    {
        return '{ "lights": { "' + lightId + '": ' 
            + constructOneLightsConfig(lightId, deviceName, httpPort) 
            + '} }';
    }

    function constructOneLightsConfig(lightId, deviceName, httpPort)
    {
        return '{"state": {"on": false, "bri": 254, "hue": 15823, "sat": 88, "effect": "none", "ct": 313, "alert": "none", "colormode": "ct", "reachable": true, "xy": [0.4255, 0.3998]}, "type": "Extended color light", "name": "' + deviceName + '", "modelid": "LCT001", "manufacturername": "Philips", "uniqueid": "' + lightId + '", "swversion": "65003148", "pointsymbol": {"1": "none", "2": "none", "3": "none", "4": "none", "5": "none", "6": "none", "7": "none", "8": "none"}}';
    }

    function constructSetupXml(lightId, deviceName, httpPort)
    {
        //IP Address of this local machine
        var ip = require("ip").address();

        var fs = require('fs');
        var rawXml = fs.readFileSync(__dirname + '/setup.xml');
        rawXml = rawXml.toString();
        rawXml = rawXml.replace("IP_ADDRESS_WITH_PORT", ip + ":" + httpPort);
        rawXml = rawXml.replace("UUID_UUID_UUID", lightId);

        return rawXml;
    }

    function handleAlexaDeviceRequestFunction(request, response, thisNode, config, uuid)
    {
        //Sanity check
        if (request === null || request === undefined || request.data === null || request.data === undefined) {
            thisNode.status({fill:"red", shape:"dot", text:"Invalid request (p:" + httpPort + ")"});
            return;
        }

        //Node parameters
        var lightId = ("" + config.id).replace(".", "");
        var deviceName = "";
        if (config.devicename)
            deviceName = config.devicename;
        var httpPort = 8082;
        if (config.port && config.port > 0)
            httpPort = config.port;

        //Use the json from Alexa as the base for our msg
        var msg = request.data;

        //Add extra 'payload' parameter which if either "on" or "off"
        var onoff = "off";
        if (request.data.on)
            onoff = "on";
        msg.payload = onoff;

        //Massage brightness parameter
        if (msg.bri) {
            msg.bri_normalized = msg.bri / 255.0;
            msg.bri = msg.bri / 255.0 * 100.0;
        } else {
            msg.bri = (onoff == "on") ? 100.0 : 0.0;
            msg.bri_normalized = (onoff == "on") ? 1.0 : 0.0;
        }

        //Send the message to next node
        thisNode.send(msg);

        //Response to Alexa
        var responseStr = '[{"success":{"/lights/' + uuid + '/state/on":' + request.data.on + '}}]';
        console.log("Sending response to " + request.connection.remoteAddress, responseStr);
        thisNode.status({fill:"blue", shape:"dot", text:"" + onoff + " (p:" + httpPort + ")"});
        response.writeHead(200, "OK", {'Content-Type': 'application/json'});
        response.end(responseStr);
    }

    function handleHueApiRequestFunction(request, response, thisNode, config)
    {
        console.log(request.method, request.url, request.connection.remoteAddress);

        //Node parameters
        var lightId = ("" + config.id).replace(".", "");
        var deviceName = "";
        if (config.devicename)
            deviceName = config.devicename;
        var httpPort = 8082;
        if (config.port && config.port > 0)
            httpPort = config.port;

        var url = request.url;
        var lightMatch = /^\/api\/(\w*)\/lights\/([\w\-]*)/.exec(request.url);

        //Control 1 single light
        if (lightMatch)
        {
            var token = lightMatch[1];
            var uuid = lightMatch[2];
            uuid = uuid.replace("/", "");

            //Receiving PUT request
            if (request.method == 'PUT')
            {
                request.on('data', function(chunk) {
                    console.log("Receiving PUT data ", chunk.toString());
                    request.data = JSON.parse(chunk);
                });
                request.on('end', function() {
                    handleAlexaDeviceRequestFunction(request, response, thisNode, config, uuid);
                });
            } 
            //GET 1 single light info
            else {
                console.log("Sending light " + uuid + " to " + request.connection.remoteAddress);
                var lightJson = constructOneLightsConfig(uuid, deviceName, httpPort);
                response.writeHead(200, {'Content-Type': 'application/json'});
                response.end(lightJson);
            }
        }

        //List all lights
        else if (/^\/api/.exec(request.url)) 
        {
            //console.log("Sending all lights json to " + request.connection.remoteAddress);
            thisNode.status({fill:"yellow", shape:"dot", text:"/lights (p:" + httpPort + ")"});
            var allLightsConfig = constructAllLightsConfig(lightId, deviceName, httpPort);
            response.writeHead(200, {'Content-Type': 'application/json'});
            response.end(allLightsConfig);
        }

        //Discovery XML
        else if (request.url == '/upnp/amazon-ha-bridge/setup.xml') 
        {
            //console.log("Sending setup.xml to " + request.connection.remoteAddress);
            var rawXml = constructSetupXml(lightId, deviceName, httpPort);
            thisNode.status({fill:"yellow", shape:"dot", text:"/setup.xml (p:" + httpPort + ")"});
            response.writeHead(200, {'Content-Type': 'application/xml'});
            response.end(rawXml);    
        }
    }

    //NodeRED registration
    RED.nodes.registerType("alexa-local", AlexaLocalNode, {
      settings: {
          alexaLocalAlexaDeviceName: {
              value: "Light",
              exportable: true
          }
      }
    });
}
