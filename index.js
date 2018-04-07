//variables placed here are shared by all nodes
var storage = require('node-persist');

//this should be a number that does not round nicely when convert to 0-100 range
const bri_default = 126;
const bri_step = 25;

module.exports = function(RED) 
{
    'use strict';

    //NodeRED node constructor
    function AlexaLocalNode(config) 
    {
        RED.nodes.createNode(this, config);
        var thisNode = this;

        //Initialize persist storage
        storage.initSync({dir: `${RED.settings.userDir}/alexa-local/persist`});

        //Restore saved port number, if any
        //port == 0 when not available -> any available port (first time)
        var lightId = formatUUID(config.id);
        var port = getPortForLightId(lightId);

        //HTTP Server to host the Hue API
        //We use stoppable to kill the server completely upon a deploy
        const graceMilliseconds = 500;
        var stoppable = require('stoppable');
        var http = require('http');
        var httpServer = stoppable(http.createServer(function(request, response){
            handleHueApiRequestFunction(request, response, thisNode, config);
        }), graceMilliseconds);

        //handle httpServer error (eg. listen EACCES 0.0.0.0:80 • a.k.a port in use)
        httpServer.on('error', function(error) {
            if (!error) {
                thisNode.status({fill:"red", shape:"ring", text:"unable to start [0] (p:" + port + ")"});
                return;
            }

            var errorCode = null;
            if (error.code)         errorCode = error.code;
            else if (error.errno)   errorCode = error.errno;

            var errorText = "";
            if (errorCode)          errorText += errorCode;
            else                    errorText += "unable to start [1]";
            errorText += " (p:" + port + ")";

            thisNode.status({fill:"red", shape:"ring", text:errorText});
            thisNode.error(error);
        });

        //Start server
        httpServer.listen(port, function(error) {
            if (error) {
                thisNode.status({fill:"red", shape:"ring", text:"unable to start [2] (p:" + port + ")"});
                RED.log.error(error);
                return;
            }

            //Extract the actual port number that was used
            var actualPort = httpServer.address().port;

            //Persist the port number attached to this NodeID
            setPortForLightId(lightId, actualPort);

            config.port = actualPort;
            thisNode.status({fill:"green", shape:"dot", text:"online (p:" + actualPort + ")"});

            //Start discovery service after we know the port number            
            startSSDP(thisNode, actualPort, config);
        });

        //Input to update 'bri' value
        thisNode.on('input', function(msg) {
            handleInputMessage(thisNode, config, msg);
        });

        //Clean up procedure before re-deploy
        thisNode.on('close', function(removed, doneFunction) {
            if (removed) {
                clearPortForLightId(lightId);
                clearLightBriForLightId(lightId);
                clearLightStateForLightId(lightId);
            }
            httpServer.stop(function(){
                if (typeof doneFunction === 'function')
                    doneFunction();
                RED.log.info("AlexaLocalNode closing done...");
            });
            setImmediate(function(){
                httpServer.emit('close');
            });
        });
    }

    //NodeRED registration
    RED.nodes.registerType("alexa-local", AlexaLocalNode, {
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
            RED.log.error(errorMsg);
            return;
        }

        var ssdp = require("peer-ssdp");
        var peer = ssdp.createPeer();
        peer.on("ready", function(){
        });
        peer.on("notify", function(headers, address){
        });
        peer.on("search", function(headers, address){
            var isValid = headers.ST && headers.MAN == '"ssdp:discover"';
            if (!isValid)
                return;

            var uuid = formatUUID(config.id);
            var hueuUuid = formatHueBridgeUUID(config.id);

            // {{networkInterfaceAddress}} will be replaced with the actual IP Address of
            // the corresponding network interface. 
            var xmlLocation = "http://{{networkInterfaceAddress}}:" + port + "/upnp/amazon-ha-bridge/setup.xml";

            // Response with 3 different templates
            // https://github.com/bwssytems/ha-bridge/blob/master/src/main/java/com/bwssystems/HABridge/upnp/UpnpListener.java
            var responseObj1 = {
                                HOST: "239.255.255.250:1900",
                                "CACHE-CONTROL": "max-age=100",
                                EXT: "",
                                LOCATION: xmlLocation,
                                SERVER: "Linux/3.14.0 UPnP/1.0 IpBridge/1.17.0",
                                "hue-bridgeid": uuid,
                                ST: "upnp:rootdevice",
                                USN: "uuid:" + hueuUuid
                              };
            var responseObj2 = {
                                HOST: "239.255.255.250:1900",
                                "CACHE-CONTROL": "max-age=100",
                                EXT: "",
                                LOCATION: xmlLocation,
                                SERVER: "Linux/3.14.0 UPnP/1.0 IpBridge/1.17.0",
                                "hue-bridgeid": uuid,
                                ST: "uuid:" + hueuUuid,
                                USN: "uuid:" + hueuUuid
                              };
            var responseObj3 = {
                                HOST: "239.255.255.250:1900",
                                "CACHE-CONTROL": "max-age=100",
                                EXT: "",
                                LOCATION: xmlLocation,
                                SERVER: "Linux/3.14.0 UPnP/1.0 IpBridge/1.17.0",
                                "hue-bridgeid": uuid,
                                ST: "urn:schemas-upnp-org:device:basic:1",
                                USN: "uuid:" + hueuUuid
                              };

            //Delay: timing fix for Echo Dot Gen 2
            //https://github.com/bwssytems/ha-bridge/issues/860
            setTimeout(function() {
                peer.reply(responseObj1, address);
            }, 1500 + 100*1);

            setTimeout(function() {
                peer.reply(responseObj2, address);
            }, 1500 + 100*2);

            setTimeout(function() {
                peer.reply(responseObj3, address);
            }, 1500 + 100*3);

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

    function constructAllLightsConfig(uuid, deviceName, httpPort)
    {
        return '{ "lights": { "' + uuid + '": ' 
            + constructOneLightConfig(uuid, deviceName, httpPort) 
            + '} }';
    }

    function constructOneLightConfig(uuid, deviceName, httpPort)
    {
        var state = getLightStateForLightId(uuid);
        if (state === undefined || state === null)
            state = "true";
        else
            state = state ? "true" : "false";

        var fullResponseString = '{"state": {"on": ' + state + ', "bri": ' + bri_default + ', "hue": 15823, "sat": 88, "effect": "none", "ct": 313, "alert": "none", "colormode": "ct", "ct": 365, "reachable": true, "xy": [0.4255, 0.3998]}, "type": "Extended color light", "name": "' + deviceName + '", "modelid": "LCT004", "manufacturername": "Philips", "uniqueid": "' + uuid + '", "swversion": "65003148", "pointsymbol": {"1": "none", "2": "none", "3": "none", "4": "none", "5": "none", "6": "none", "7": "none", "8": "none"}}';
        RED.log.debug(fullResponseString);

        return fullResponseString;
    }

    function constructBridgeSetupXml(lightId, deviceName, httpPort)
    {
        //IP Address of this local machine
        var ip = require("ip").address();

        //Unique UUID for each bridge device
        var uuid = formatUUID(lightId);
        var bridgeUUID = formatHueBridgeUUID(lightId);

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

        //Debug
        RED.log.debug(lightId + ' ' + deviceName + ' ' + request.method + ' ' + request.url + ' ' + request.connection.remoteAddress)

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
                    RED.log.debug("Receiving PUT data " + chunk.toString());
                    request.data = JSON.parse(chunk);
                });
                request.on('end', function() {
                    handleAlexaDeviceRequestFunction(request, response, thisNode, config, uuid);
                });
            } 
            //GET 1 single light info
            else {
                RED.log.debug("Sending light " + uuid + " to " + request.connection.remoteAddress);
                var lightJson = constructOneLightConfig(uuid, deviceName, httpPort);
                response.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
                response.end(lightJson);
            }
        }

        //Authorization step (press button on Hue Bridge)
        else if (authMatch) 
        {
            const HUE_USERNAME = "1028d66426293e821ecfd9ef1a0731df";
            var responseStr = '[{"success":{"username":"' + HUE_USERNAME + '"}}]';

            //Response to Hue app
            RED.log.debug("Sending response to " + request.connection.remoteAddress, responseStr);
            thisNode.status({fill:"blue", shape:"dot", text:"auth" + " (p:" + httpPort + ")"});
            response.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
            response.end(responseStr);
        }

        //List all lights
        else if (/^\/api/.exec(request.url)) 
        {
            RED.log.debug("Sending all lights json to " + request.connection.remoteAddress);
            thisNode.status({fill:"yellow", shape:"dot", text:"/lights (p:" + httpPort + ")"});
            var allLightsConfig = constructAllLightsConfig(lightId, deviceName, httpPort);
            response.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
            response.end(allLightsConfig);
        }

        //Discovery XML
        else if (request.url == '/upnp/amazon-ha-bridge/setup.xml') 
        {
            RED.log.debug("Sending setup.xml to " + request.connection.remoteAddress);
            thisNode.status({fill:"yellow", shape:"dot", text:"discovery (p:" + httpPort + ")"});
            var rawXml = constructBridgeSetupXml(lightId, deviceName, httpPort);
            response.writeHead(200, {'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*'});
            response.end(rawXml);    
        }
    }

    // -----------------------------------------------------------------------------------------------
    // Handle HTTP Request / Alexa
    // -----------------------------------------------------------------------------------------------

    /*
     * Handle actual valid request to turn on/off device
     */
    function handleAlexaDeviceRequestFunction(request, response, thisNode, config, uuid)
    {
        //Sanity check
        if (request === null || request === undefined || request.data === null || request.data === undefined) {
            thisNode.status({fill:"red", shape:"dot", text:"Invalid request (p:" + httpPort + ")"});
            return;
        }

        //Use the json from Alexa as the base for our msg
        var msg = request.data;

        //Differentiate between on/off and dimming command. Issue #24
        var isOnOffCommand = (msg.on !== undefined && msg.on !== null) && (msg.bri === undefined || msg.bri === null);
        msg.on_off_command = isOnOffCommand;

        //Add extra 'payload' parameter which if either "on" or "off"
        var onoff = "off";
        if (request.data.on)        //true/false
            onoff = "on";
        msg.payload = onoff;

        justDoIt(thisNode, config, uuid, msg);

        //Retrieve the last known state
        var state = getLightStateForLightId(uuid);
        RED.log.debug("State: " + state);
        if (state === undefined || state === null)
            state = "true";
        else
            state = state ? "true" : "false";

        //Response to Alexa
        var responseStr = '[{"success":{"/lights/' + uuid + '/state/on":' + state + '}}]';
        RED.log.debug("Sending response to " + request.connection.remoteAddress, responseStr);
        response.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
        response.end(responseStr);
    }

    function justDoIt(thisNode, config, uuid, msg)
    {
        //Node parameters
        var deviceName = "";
        if (config.devicename)
            deviceName = config.devicename;
        var httpPort = 8082;
        if (config.port && config.port > 0)
            httpPort = config.port;

        //Detect increase/decrease command
        msg.change_direction = 0;
        if (msg.bri && msg.bri == bri_default - 64)     //magic number
            msg.change_direction = -1;
        if (msg.bri && msg.bri == bri_default + 63)     //magic number
            msg.change_direction = 1;

        //Toggle command
        if (msg.payload === "toggle") {
            var state = getLightStateForLightId(uuid);
            var isOn = !state;
            msg.payload = isOn ? "on" : "off";
        }

        //Dimming or Temperature command
        if (msg.bri) {
            //Save the last value (raw value)
            setLightBriForLightId(uuid, msg.bri);

            msg.bri = Math.round(msg.bri / 255.0 * 100.0);
            msg.bri_normalized = msg.bri / 100.0;
            msg.on = msg.bri > 0;
            msg.payload = msg.on ? "on" : "off";

            //Save the last state value
            setLightStateForLightId(uuid, msg.on);

            //Node status
            thisNode.status({fill:"blue", shape:"dot", text:"bri:" + msg.bri + " (p:" + httpPort + ")"});
        }
        //On/off command
        else {
            var isOn = (msg.payload == "on")
            msg.bri = isOn ? 100 : 0;
            msg.bri_normalized = isOn ? 1.0 : 0.0;

            //Save the last state value
            setLightStateForLightId(uuid, isOn);

            //Restore the previous value before off command
            var savedBri = getLightBriForLightId(uuid);
            if (isOn) {
                if (savedBri && savedBri > 0) {
                    msg.bri = Math.round(savedBri / 255.0 * 100.0);
                    msg.bri_normalized = msg.bri / 100.0;
                }
            }
            //Output the saved bri value for troubleshooting
            else {
                if (savedBri) {
                    msg.saved_bri = Math.round(savedBri / 255.0 * 100.0);
                    msg.save_bri_normalized = msg.saved_bri / 100.0;
                }
            }

            //Node status
            thisNode.status({fill:"blue", shape:"dot", text:"" + msg.payload + " (p:" + httpPort + ")"});
        }

        //Add extra device parameters
        msg.device_name = deviceName;
        msg.light_id = uuid;
        msg.port = httpPort;

        //Send the message to next node
        thisNode.send(msg);
    }


    // -----------------------------------------------------------------------------------------------
    // Input Hanlding
    // -----------------------------------------------------------------------------------------------

    function handleInputMessage(thisNode, config, msg)
    {
        if (msg == null || msg.payload === null || msg.payload === undefined) {
            thisNode.status({fill:"red", shape:"dot", text:"invalid payload received"});
            return;
        }

        var lightId = formatUUID(config.id);

        //Differentiate between on/off and dimming command. Issue #24
        var isOnOffCommand = false;

        var briInput = 0;
        msg.payload = "" + msg.payload;
        msg.payload = msg.payload.trim().toLowerCase();
        if (msg.payload === "toggle") {
            isOnOffCommand = true;
        }
        else if (msg.payload === "on") {
            msg.payload = "on";
            briInput = 100;
            isOnOffCommand = true;
        }
        else if (msg.payload === "off") {
            msg.payload = "off";
            briInput = 0;
            isOnOffCommand = true;
        }
        else if (msg.payload.startsWith("+") || msg.payload.startsWith("-")) {
            var delta100 = Math.round(parseFloat(msg.payload));                 //given by user in 0-100 range
            var delta255 = Math.round(delta100 / 100.0 * 255.0)
            var currentBri = getLightBriForLightId(lightId);
            briInput = Math.round((currentBri + delta255) / 255.0 * 100.0);
            briInput = Math.min(100, Math.max(briInput, 0));                    //limit 0-100 range
            msg.bri = Math.round(parseFloat(briInput) / 100.0 * 255.0);         //mapping 0-100 to 0-255 scale
            msg.payload = (msg.bri > 0) ? "on" : "off";
            isOnOffCommand = false;
        }
        else if (msg.payload === "increase" || msg.payload === "brighter") {
            var currentBri = getLightBriForLightId(lightId);
            briInput = Math.round((currentBri + 63) / 255.0 * 100.0);
            briInput = Math.min(100, Math.max(briInput, 0));                    //limit 0-100 range
            msg.bri = Math.round(parseFloat(briInput) / 100.0 * 255.0);         //mapping 0-100 to 0-255 scale
            msg.payload = (msg.bri > 0) ? "on" : "off";
            isOnOffCommand = false;
        }
        else if (msg.payload === "decrease" || msg.payload === "dimmer") {
            var currentBri = getLightBriForLightId(lightId);
            briInput = Math.round((currentBri - 64) / 255.0 * 100.0);           //mapping 0-255 to 0-100 scale
            briInput = Math.min(100, Math.max(briInput, 0));                    //limit 0-100 range
            msg.bri = Math.round(parseFloat(briInput) / 100.0 * 255.0);         //mapping 0-100 to 0-255 scale
            msg.payload = (msg.bri > 0) ? "on" : "off";
            isOnOffCommand = false;
        }
        else {
            briInput = Math.round(parseFloat(msg.payload));
            briInput = Math.min(100, Math.max(briInput, 0));                    //limit 0-100 range
            msg.bri = Math.round(parseFloat(msg.payload) / 100.0 * 255.0);      //mapping 0-100 to 0-255 scale
            msg.payload = (msg.bri > 0) ? "on" : "off";
            isOnOffCommand = false;
        }

        msg.on_off_command = isOnOffCommand;

        //Check if we want to trigger the node
        var inputTrigger = false;
        if (config.inputtrigger)
            inputTrigger = config.inputtrigger;
        if (inputTrigger) {
            justDoIt(thisNode, config, lightId, msg);
            return;
        }

        //No trigger, simply update the internal 'bri' value
        var bri = Math.round(briInput / 100.0 * 255.0);
        setLightBriForLightId(lightId, bri);
        thisNode.status({fill:"blue", shape:"dot", text:"updated bri:" + briInput});
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

    function formatHueBridgeUUID(lightId)
    {
        if (lightId === null || lightId === undefined)
            return "";
        var uuid = "f6543a06-da50-11ba-8d8f-";
        uuid += formatUUID(lightId);
        return uuid;  // f6543a06-da50-11ba-8d8f-5ccf7f139f3d
    }

    /*
     * Retrieve the port number used by a given NodeId from persistent storage
     */
    function getPortForLightId(lightId) 
    {
        if (storage === null || storage === undefined)
            return 0;
        if (lightId === null || lightId === undefined)
            return 0;

        var key = formatUUID(lightId);
        var value = storage.getItemSync(key);
        if (value === null || value === undefined || value <= 0 || value >= 65536)
            return 0;

        return value;
    }

    /*
     * Save the port number used by a given NodeId to persistent storage
     */
    function setPortForLightId(lightId, value) 
    {
        var key = formatUUID(lightId);
        if (storage)
            storage.setItemSync(key, value);
    }

    /*
     * Remove the port number used by a given NodeId in persistent storage
     */
    function clearPortForLightId(lightId) 
    {
        var key = formatUUID(lightId);
        if (storage)
            storage.removeItemSync(key);
    }

    /*
     * Retrieve the 'bri' value used by a given NodeId from persistent storage
     */
    function getLightBriForLightId(lightId) 
    {
        if (storage === null || storage === undefined) {
            RED.log.warn("storage is null in getLightBriForLightId");
            return null;
        }
        if (lightId === null || lightId === undefined) {
            RED.log.warn("lightId is null");
            return null;
        }

        var key = formatUUID(lightId) + "_bri";
        var value = storage.getItemSync(key);
        if (value === null || value === undefined || value < 0 || value >= 65536) {
            //RED.log.warn("light bri is null in storage");
            return null;
        }

        return value;
    }

    /*
     * Save the 'bri' value used by a given NodeId to persistent storage
     */
    function setLightBriForLightId(lightId, value) 
    {
        if (storage === null || storage === undefined) {
            RED.log.warn("storage is null in setLightBriForLightId");
            return null;
        }
        if (lightId === null || lightId === undefined) {
            RED.log.warn("lightId is null");
            return null;
        }

        var key = formatUUID(lightId) + "_bri";
        storage.setItemSync(key, value);
    }

    /*
     * Remove the 'bri' value used by a given NodeId in persistent storage
     */
    function clearLightBriForLightId(lightId) 
    {
        if (storage === null || storage === undefined) {
            RED.log.warn("storage is null in clearLightBriForLightId");
            return null;
        }
        if (lightId === null || lightId === undefined) {
            RED.log.warn("lightId is null");
            return null;
        }

        var key = formatUUID(lightId) + "_bri";
        storage.removeItemSync(key);
    }

    /*
     * Retrieve the 'bri' value used by a given NodeId from persistent storage
     */
    function getLightBriForLightId(lightId) 
    {
        if (storage === null || storage === undefined) {
            RED.log.warn("storage is null in getLightBriForLightId");
            return null;
        }
        if (lightId === null || lightId === undefined) {
            RED.log.warn("lightId is null");
            return null;
        }

        var key = formatUUID(lightId) + "_bri";
        var value = storage.getItemSync(key);
        if (value === null || value === undefined || value < 0 || value >= 65536) {
            RED.log.warn("light bri is null in storage");
            return null;
        }

        return value;
    }

    /*
     * Save the 'bri' value used by a given NodeId to persistent storage
     */
    function setLightBriForLightId(lightId, value) 
    {
        var key = formatUUID(lightId) + "_bri";
        if (storage)
            storage.setItemSync(key, value);
    }

    /*
     * Remove the 'bri' value used by a given NodeId in persistent storage
     */
    function clearLightBriForLightId(lightId) 
    {
        var key = formatUUID(lightId) + "_bri";
        if (storage)
            storage.removeItemSync(key);
    }

    /*
     * Retrieve the 'bri' value used by a given NodeId from persistent storage
     */
    function getLightStateForLightId(lightId) 
    {
        if (storage === null || storage === undefined) {
            RED.log.warn("storage is null in getLightStateForLightId");
            return null;
        }
        if (lightId === null || lightId === undefined) {
            RED.log.warn("lightId is null");
            return null;
        }

        var key = formatUUID(lightId) + "_state";
        var value = storage.getItemSync(key);
        if (value === null || value === undefined || value < 0 || value >= 65536) {
            //RED.log.warn("light state is null in storage");
            return null;
        }

        return value;
    }

    /*
     * Save the 'bri' value used by a given NodeId to persistent storage
     */
    function setLightStateForLightId(lightId, value) 
    {
        if (storage === null || storage === undefined) {
            RED.log.warn("storage is null in setLightStateForLightId");
            return;
        }
        if (lightId === null || lightId === undefined) {
            RED.log.warn("lightId is null");
            return null;
        }

        var key = formatUUID(lightId) + "_state";
        storage.setItemSync(key, value);
    }

    /*
     * Remove the 'bri' value used by a given NodeId in persistent storage
     */
    function clearLightStateForLightId(lightId) 
    {
        if (storage === null || storage === undefined) {
            RED.log.warn("storage is null in clearLightStateForLightId");
            return;
        }
        if (lightId === null || lightId === undefined) {
            RED.log.warn("lightId is null");
            return null;
        }

        var key = formatUUID(lightId) + "_state";
        storage.removeItemSync(key);
    }
}
