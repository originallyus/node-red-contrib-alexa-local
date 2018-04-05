# node-red-contrib-alexa-local

![Usage screenshot](https://raw.githubusercontent.com/originallyus/node-red-contrib-alexa-local/master/screenshot2.png "Screenshot")

This is a dead-simple node for adding Alexa capability to your NodeRED flow.

**NO Alexa Skills required.**

**NO account linking required.**

**NO complicated parameters, it just works.**


Developed by the super cool folks at [Originally US](http://originally.us) - a mobile app development company from Singapore

## Installation

Install directly from your NodeRED's Setting Pallete

or

Change your working directory to your node red installation. Usually it's in ~/.node-red.

    $ npm install node-red-contrib-alexa-local

## How to use
  * Add this node to your flow
  * Give it a unique **Device Name**
  * Ask "Alexa, discover devices"
  * That's it!

![Usage screenshot](https://raw.githubusercontent.com/originallyus/node-red-contrib-alexa-local/master/screenshot3.png "Screenshot")


## Known issues
  * Doesn't support Echo Gen 2 & Echo Plus local devices discovery yet
  * Echo Show, Echo Spot, Sonos One do not have the capability to discovery devices locally

## FAQ
**Does it support German or other languages?**
Yes! As long as Alexa supports that language.

**Does it support door lock/curtain/AV/TV or other types of devices?**
Unfortunately no. In order to keep this node so simple to use, it was designed to emulate a Philips Hue bridge & device within local network. Amazon Echo is hardcoded to support only on/off/dimming command via this route. Any other type of support has to go through the Alexa Skills route (cloud-based). There is another node does just that [node-red-contrib-alexa-home-skill](https://github.com/hardillb/node-red-contrib-alexa-home-skill)

**Example dimming commands**
  *  Alexa, set Kitchen Light to 40%
  *  Alexa, set Aircon temperature to 30
  *  Alexa, increase Kitchen Light
  *  Alexa, lower Kitchen Light by 15%

**Do I need to enable any Alexa Skils?**
No. Nah. Non. Nein. Never.

**Is this free forever?**
Yes. We won't charge you anything. If you wants to help us out, buy us some coffee or RedBull.

**I have some suggestions, how do I get in touch?**
Please create an issue in [Github](https://github.com/originallyus/node-red-contrib-alexa-local/issues)

**How do I control my (non-smart) devices at home with NodeRED?**
Check out [RMPlugin app](https://play.google.com/store/apps/details?id=us.originally.tasker&hl=en) developed by us. Here's an [intro video](https://www.youtube.com/watch?v=QUKYKhK57sc) for the hardware.


## TODO
  * Alexa isolation
  * Support Echo Gen 2 & Echo Plus discovery
