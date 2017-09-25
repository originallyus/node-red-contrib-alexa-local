module.exports = function(RED) {
    function AlexaLocalNode(config) {
        RED.nodes.createNode(this,config);
        var node = this;
        var deviceName = config.devicename;
        var dimmable = config.dimmable;
        node.warn("deviceName: " + deviceName);
        node.warn("dimmable: " + dimmable);

        node.on('input', function(msg) {
            msg.payload = msg.payload.toLowerCase();
            node.send(msg);
        });
    }
    RED.nodes.registerType("alexa-local", AlexaLocalNode, {
      settings: {
          alexaLocalAlexaDeviceName: {
              value: "Light",
              exportable: true
          }
      }
    });
}
