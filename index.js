module.exports = function(RED) 
{
    //variables placed here are shared by all nodes
    var storage = require('node-persist');

    //NodeRED node constructor
    function AlexaLocalNode(config) 
    {
        RED.nodes.createNode(this, config);
        var thisNode = this;

        //Initialize persist storage
        storage.initSync({dir: 'nodered/alexa-local/persist'});

        //Restore saved port number, if any
        //port == 0 when not available -> any available port (first time)
        var lightId = formatUUID(config.id);
        var port = getPortForUUID(lightId);

        //HTTP Server to host the Hue API
        var http = require('http');
        var httpServer = http.createServer(function(request, response){
            handleHueApiRequestFunction(request, response, thisNode, config);
        });
        httpServer.listen(port, function(error) {
            if (error) {
                thisNode.status({fill:"red", shape:"ring", text:"unable to start"});
                console.error(error);
                return;
            }

            //Extract the actual port number that was used
            var actualPort = httpServer.address().port;

            //Persist the port number attached to this NodeID
            setPortForUUID(lightId, actualPort);

            config.port = actualPort;
            thisNode.status({fill:"green", shape:"dot", text:"online (p:" + actualPort + ")"});

            //Start discovery service after we know the port number            
            startSSDP(thisNode, actualPort, config);
        });

        //Clean up procedure before re-deploy
        this.on('close', function(removed, done) {
            httpServer.close(function(){
                done()
            });
            setImmediate(function(){
                httpServer.emit('close')
            });
            done();
        });
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


    // -----------------------------------------------------------------------------------------------
    // SSDP Discovery service
    // -----------------------------------------------------------------------------------------------

    //Start SSDP discovery service with the port discovered by HTTP server
    function startSSDP(thisNode, port, config)
    {
        //Sanity check
        if (port === null || port === undefined || port <= 0 || port >= 65536) {
            var errorMsg = "port is in valid (" + port + ")";
            thisNode.status({fill:"red", shape:"ring", text:errorMsg});
            console.error(errorMsg);
            return;
        }

        var ssdp = require("peer-ssdp");
        var peer = ssdp.createPeer();
        peer.on("ready", function(){
        });
        peer.on("notify", function(headers, address){
        });
        peer.on("search", function(headers, address){
            //console.log("SEARCH: ", headers, address);
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
        });
        peer.on("close",function(){
        });
        peer.start();
    }


    // -----------------------------------------------------------------------------------------------
    // XML
    // -----------------------------------------------------------------------------------------------

    function constructAllLightsConfig(lightId, deviceName, httpPort)
    {
        return '{ "lights": { "' + lightId + '": ' 
            + constructOneLightConfig(lightId, deviceName, httpPort) 
            + '} }';
    }

    function constructOneLightConfig(lightId, deviceName, httpPort)
    {
        return '{"state": {"on": false, "bri": 254, "hue": 15823, "sat": 88, "effect": "none", "ct": 313, "alert": "none", "colormode": "ct", "ct": 365, "reachable": true, "xy": [0.4255, 0.3998]}, "type": "Extended color light", "name": "' + deviceName + '", "modelid": "LCT004", "manufacturername": "Philips", "uniqueid": "' + lightId + '", "swversion": "65003148", "pointsymbol": {"1": "none", "2": "none", "3": "none", "4": "none", "5": "none", "6": "none", "7": "none", "8": "none"}}';
    }

    function constructBridgeSetupXml(lightId, deviceName, httpPort)
    {
        //IP Address of this local machine
        var ip = require("ip").address();

        //TODO: change this to a dynamic value
        var bridgeUUID = "710b962e-041c-11e1-9234-0123456789ab";

        //Load setup.xml & replace dynamic values
        var fs = require('fs');
        var setupXml = fs.readFileSync(__dirname + '/setup.xml');
        setupXml = setupXml.toString();
        setupXml = setupXml.replace("IP_ADDRESS_WITH_PORT", ip + ":" + httpPort);
        setupXml = setupXml.replace("UUID_UUID_UUID", bridgeUUID);

        return setupXml;
    }


    // -----------------------------------------------------------------------------------------------
    // Handle HTTP Request / Hue API
    // -----------------------------------------------------------------------------------------------

    /*
     * Hue API emulation
     */
    function handleHueApiRequestFunction(request, response, thisNode, config)
    {
        //console.log(request.method, request.url, request.connection.remoteAddress);

        //Node parameters
        var lightId = formatUUID(config.id);
        var deviceName = "";
        if (config.devicename)
            deviceName = config.devicename;
        var httpPort = 8082;
        if (config.port && config.port > 0)
            httpPort = config.port;

        var url = request.url;
        var lightMatch = /^\/api\/(\w*)\/lights\/([\w\-]*)/.exec(request.url);
        var authMatch = /^\/api\/(\w*)/.exec(request.url) && (request.method == 'POST');

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
                var lightJson = constructOneLightConfig(uuid, deviceName, httpPort);
                response.writeHead(200, {'Content-Type': 'application/json'});
                response.end(lightJson);
            }
        }

        //Authorization step (press button on Hue Bridge)
        else if (authMatch) 
        {
            const HUE_USERNAME = "1028d66426293e821ecfd9ef1a0731df";
            var responseStr = '[{"success":{"username":"' + HUE_USERNAME + '"}}]';

            //Response to Hue app
            console.log("Sending response to " + request.connection.remoteAddress, responseStr);
            thisNode.status({fill:"blue", shape:"dot", text:"auth" + " (p:" + httpPort + ")"});
            response.writeHead(200, "OK", {'Content-Type': 'application/json'});
            response.end(responseStr);
        }

        //List all lights
        else if (/^\/api/.exec(request.url)) 
        {
            //console.log("Sending all lights json to " + request.connection.remoteAddress);
            //thisNode.status({fill:"yellow", shape:"dot", text:"/lights (p:" + httpPort + ")"});
            var allLightsConfig = constructAllLightsConfig(lightId, deviceName, httpPort);
            response.writeHead(200, {'Content-Type': 'application/json'});
            response.end(allLightsConfig);
        }

        //Discovery XML
        else if (request.url == '/upnp/amazon-ha-bridge/setup.xml') 
        {
            //console.log("Sending setup.xml to " + request.connection.remoteAddress);
            //thisNode.status({fill:"yellow", shape:"dot", text:"/setup.xml (p:" + httpPort + ")"});
            var rawXml = constructBridgeSetupXml(lightId, deviceName, httpPort);
            response.writeHead(200, {'Content-Type': 'application/xml'});
            response.end(rawXml);    
        }
    }

    // -----------------------------------------------------------------------------------------------
    // Handle HTTP Request / Alexa
    // -----------------------------------------------------------------------------------------------

    /*
     * Handle actual valid request to on/off device
     */
    function handleAlexaDeviceRequestFunction(request, response, thisNode, config, uuid)
    {
        //Sanity check
        if (request === null || request === undefined || request.data === null || request.data === undefined) {
            thisNode.status({fill:"red", shape:"dot", text:"Invalid request (p:" + httpPort + ")"});
            return;
        }

        //Node parameters
        var lightId = formatUUID(config.id);
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
            msg.bri = Math.round(msg.bri / 255.0 * 100.0);
            msg.bri_normalized = msg.bri / 100.0;
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


    // -----------------------------------------------------------------------------------------------
    // Persistent helper
    // -----------------------------------------------------------------------------------------------

    /*
     * We use NodeRED's Node ID as the UUID for Alexa device, with some tweaking
     */
    function formatUUID(lightId) 
    {
        if (lightId === null || lightId === undefined)
            return "";

        var string = ("" + lightId);
        return string.replace(".", "").trim();
    }

    /*
     * Retrieve the port number used by a given NodeId from persistent storage
     */
    function getPortForUUID(lightId) 
    {
        if (storage === null || storage === undefined)
            return 0;
        if (lightId === null || lightId === undefined)
            return 0;

        var key = formatUUID(lightId);
        var port = storage.getItemSync(key);
        if (port === null || port === undefined || port <= 0 || port >= 65536)
            return 0;

        return port;
    }

    /*
     * Save the port number used by a given NodeId to persistent storage
     */
    function setPortForUUID(lightId, port) 
    {
        var key = formatUUID(lightId);
        if (storage)
            storage.setItemSync(key, port);
    }

}
