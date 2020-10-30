/**
 *
 * Onvif adapter
 *
 */

'use strict';

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils 	= require('@iobroker/adapter-core'); // Get common adapter utils
const tools 	= require(utils.controllerDir + '/lib/tools');
//const http 	 	= require('http');
//const crypt 	= require('crypto');
const Cam   	= require('onvif').Cam;
const flow  	= require('nimble');
const url   	= require('url');
const fs    	= require('fs');
const sharp    	= require('sharp');
const httpClient = require('urllib');
const inherits 	= require('util').inherits;

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let secret;
let adapter;
let isDiscovery = false;
let cameras = {};
let timeoutID = {};

function override(child, fn) {
    child.prototype[fn.name] = fn;
    fn.inherited = child.super_.prototype[fn.name];
}

// overload Cam to preserve original hostname
function MyCam(options, callback) {
    MyCam.super_.call(this, options, callback);
}
inherits(MyCam, Cam);


override(MyCam, function getSnapshotUri(options, callback){
    getSnapshotUri.inherited.call(this, options, (err, res) => {
        if(!err) {
            const parsedAddress = url.parse(res.uri);
            // If host for service and default host dirrers, also if preserve address property set
            // we substitute host, hostname and port from settings
            if (this.hostname !== parsedAddress.hostname) {
                adapter.log.debug('need replace '+res.uri);
                res.uri = res.uri.replace(parsedAddress.hostname, this.hostname);
                adapter.log.debug('after replace '+res.uri);
            }
        }
        if (callback) callback(err, res);
    });
});

function httpGet(url, username, password, imageWidth, callback){
	if (typeof imageWidth === 'function') {
		callback = imageWidth;
		imageWidth = null;
	}
	
	const options = {
		method: 'GET',
		rejectUnauthorized: false,
		timeout: [3000, 15000],
		digestAuth: username + ":" + password,
		headers: {
			'Content-Type': 'image/jpeg'
		}
	};

	httpClient.request(url, options, (err, data, res) => {
		if (err) {
			adapter.log.error('httpGet. Error: ' + JSON.stringify(err));
			callback(null);
		} else {
			adapter.log.debug('httpGet.statusCode: ' + res.statusCode);
			adapter.log.debug('httpGet.headers: ' + JSON.stringify(res.headers));
			adapter.log.debug('httpGet.size: ' + res.size);
			
			const image = sharp(data);
			image
			.metadata()
			.then(metadata => {
				adapter.log.debug('httpGet. Image metadata: ' + JSON.stringify(metadata));
				return image
					.resize({ width: imageWidth || metadata.width })
					.toBuffer();
			})
			.then(result => {
				const img = {
					mimeType: "image/jpeg",
					rawImage: result
				};
				callback(img);
			})
			.catch(err => {
				adapter.log.error('httpGet. sharp ' + JSON.stringify(err));
				callback(null);
			});
		}
	});
}

function getSnapshot(message, callback){
	let id = message.id,
        objId = '';
		
	if (id.indexOf(adapter.namespace) >= 0) objId = id;
		else objId = adapter.namespace+'.' + id;
		
    let cam = cameras[objId];
 
	adapter.log.debug('getSnapshot. message.id: ' + JSON.stringify(objId));
	adapter.log.debug('getSnapshot. cam: ' + JSON.stringify(cam));
    if (cam) {
        // get snapshot
        cam.getSnapshotUri({protocol:'RTSP'}, function(err, stream) {
			adapter.log.debug("getSnapshot. err: " + JSON.stringify(err));
			adapter.log.debug("getSnapshot. stream: " + JSON.stringify(stream));
			if (err) {
				adapter.log.error("getSnapshot. Error: " + err);
				callback(err, null);
			} else {
				if (stream){
					adapter.log.debug('getSnapshotUri:stream.uri ' + JSON.stringify(stream.uri));
					httpGet(stream.uri, cam.username, cam.password, (message.width || null), (img) => {
						if (img) {
							callback(null, img);
						} else {
							callback('error', null);
						}
					});
				} else {
					adapter.log.error("getSnapshot. stream = NULL");
					callback(err, null);
				}
			}
        });
    } else {
		adapter.log.warn('Event: getSnapshot. The adapter is not ready. Repeat after a few seconds.');
		callback('not ready', null);
	}
}

function saveFileSnapshot(message, callback){
    let id = message.id,
		objId = '';
		
	if (id.indexOf(adapter.namespace) >= 0) objId = id;
		else objId = adapter.namespace+'.' + id;
	
    let cam = cameras[objId];
	
	adapter.log.debug('saveFileSnapshot. message.id: ' + JSON.stringify(objId));
	adapter.log.debug('saveFileSnapshot. cam: ' + JSON.stringify(cam));
    if (cam) {
        // get snapshot
        cam.getSnapshotUri({protocol:'RTSP'}, function(err, stream) {
			if (err){
				adapter.log.error("saveFileSnapshot: " + err);
				callback(err, null);
			}
			if (!err){
				adapter.log.debug('getSnapshotUri: ' + JSON.stringify(stream.uri));
				saveImage(stream.uri, cam.username, cam.password, message.file, (message.width || null), result => {
					callback(null, result);
				});
			}
        });
    } else {
		adapter.log.warn('Event: saveFileSnapshot. The adapter is not ready. Repeat after a few seconds or invalid camera ID set.');
	}
}

function saveImage(url, username, password, file, width, callback){
    let picStream;
	httpGet(url, username, password, width, (img) => {
		if (img) {
			picStream = fs.createWriteStream(file);
			picStream.write(img.rawImage);
			picStream.on('close', function() {
				adapter.log.debug('Image saved');
				callback("OK");
			});
			picStream.end();
		} else {
			callback('httpGet error');
		}
		
	});
}

function getSettingsCamera(msg, callback){
	var id = msg.id,
        objId = adapter.namespace+'.' + id;
	adapter.log.debug("getForeignState. objId: " + objId);	                  
	adapter.getForeignObject(objId, (error, obj) => {
		if (!error) {
			adapter.log.debug("getForeignState: " + JSON.stringify(obj));
			adapter.getState(objId + '.subscribeEvents', (err, state) => {
				if (err) {
					callback && callback();
				} else {
					obj.native.subscribeEvents = state.val;
					callback && callback(obj);
				}
			})
		} else {
			adapter.log.error(JSON.stringify(error));
			callback && callback();
		}
	});
}

function setChangeCam(msg, callback){
	var id = msg.id,
        objId = adapter.namespace+'.' + id;
	adapter.log.debug("setChangeCam. objId: " + objId);	
	
	let password = msg.password;
	/*if (!adapter.supportsFeature || !adapter.supportsFeature('ADAPTER_AUTO_DECRYPT_NATIVE')) {
		secret = (systemConfig && systemConfig.native && systemConfig.native.secret) || 'Zgfr56gFe87jJOM';
		password = tools.encrypt(secret, msg.password);
	} else {
		password = msg.password;
	}*/
	
	adapter.extendObject(objId, {
		common: {name: msg.name},
		native: {
			user: msg.user,
			password: password,
			subscribeEvents: msg.events
		}
	}, obj => {
		adapter.log.debug("setChangeCam. newObj: " + obj);
		updateState(objId, 'subscribeEvents', msg.events, {"type": "boolean", "read": true, "write": true});
		callback && callback(obj);
	});
}

async function getDevices(){
	return new Promise((resolve, reject) => {
		adapter.getDevices((err, result) => {
			if (err) reject(err);
			adapter.log.debug('getDevices: ' + JSON.stringify(result));
			resolve(result);
		});
	});
}

const classCam = item => new Promise((resolve) => {
	adapter.log.debug('classCam: item = ' + JSON.stringify(item));
	let devData = item.native,
		cam, 
		password = devData.password;
		
	/*if (!adapter.supportsFeature || !adapter.supportsFeature('ADAPTER_AUTO_DECRYPT_NATIVE')) {
		secret = (systemConfig && systemConfig.native && systemConfig.native.secret) || 'Zgfr56gFe87jJOM';
		password = tools.decrypt(secret, devData.password);
	} else {
		password = devData.password;
	}*/
	cam = new MyCam({
		hostname: devData.ip,
		port: devData.port,
		username: devData.user,
		password: password,
		timeout : 15000,
		preserveAddress: true
	},(err) => {
		if (!err) {
			cameras[item._id] = cam;
			adapter.log.debug('classCam. Camera/NVT: ' + JSON.stringify(cameras));
			return resolve();
		} else {
			adapter.log.error(`classCam. Camera/NVT: ${JSON.stringify(devData.name)} ${err}`);
			return resolve();
		}
	});
});

async function setCameras(devices){
	cameras = {};
    adapter.log.debug('setCameras: ' + JSON.stringify(devices));
	return Promise.all(devices.map(async(item) => {
		await classCam(item);
	}));
}

function PullPointSubscription(cam, id, callback){
	cam.createPullPointSubscription((err, data) => {
		if (err) {
			adapter.log.error("createPullPointSubscription: " + err);
			updateState(id, 'connection', false, {"type": "boolean", "read": true, "write": false});
			callback && callback('stop');
		} else {
			adapter.log.debug("createPullPointSubscription: " + JSON.stringify(data));
			updateState(id, 'connection', true, {"type": "boolean", "read": true, "write": false});
			let countErr = 0;
			if (typeof timeoutID[id] !== 'undefined'){
				timeoutID[id] = setTimeout(function tick(){
					cam.renew({timeout: 9000, messageLimit: 10}, (err, events) => { //added renew subscription here - not sure if we need the options for it though
					});
					cam.pullMessages({timeout: 9000, messageLimit: 10}, (err, events) => {
						if (typeof timeoutID[id] !== 'undefined'){
							if (err) {
								countErr++;
								adapter.log.warn(`startCameras (${id}) pullMessages: ERROR - ${err} (count error = ${countErr}). Resubscribe to events`);
								if (countErr > 3){
									adapter.log.error(`Camera/NVT (${id}) did not answer several times in a row. Disconnected!`);
									clearTimeout(timeoutID[id]);
									updateState(id, 'connection', false, {"type": "boolean", "read": true, "write": false});
									callback && callback('stop');
								} else {
									timeoutID[id] = setTimeout(tick, 10000);
								}
							} else {
								countErr = 0;
								if (events.notificationMessage) {
									adapter.log.debug(`EVENT (${id}): ${JSON.stringify(events)}`);
									
									if (Array.isArray(events.notificationMessage)){
										events.notificationMessage.forEach(topic => {
											camEvents(id, topic);
										});
									} else {
										camEvents(id, events.notificationMessage);
									}
								}
								timeoutID[id] = setTimeout(tick, 10000);
							}
						}
					});
				}, 1000);
			}
		}
	});
}

async function startCameras(){
    adapter.log.debug('startCameras');
	clearTimeouts();
    try {
		let devices = await getDevices();
		await setCameras(devices);
		adapter.log.debug('startCameras. cameras: ' + JSON.stringify(cameras));
		if (Object.keys(cameras).length == 0){
			adapter.log.warn("startCameras: Cameras/NVT unavailables");
			timeoutID.Restart = setTimeout(startCameras, 600000); // Restart adapter 10 min
		} else for (let item of devices) {
			let dev = item,
            devData = dev.native,
            cam;
			
			updateState(devData.id, 'connection', false, {"type": "boolean", "read": true, "write": false});
			adapter.getState(devData.id + '.subscribeEvents', (err, state) => {
				if (err) {
					adapter.log.error('startCameras. ' + devData.id + '.subscribeEvents: ' + err);
					return;
				}
				if ((devData.events === true)&&(state.val)) {
					timeoutID[devData.id] = 'OK';
					cam = cameras[dev._id];
					// message subscription
					if (typeof cam !== 'undefined'){
						timeoutID.subscribeRestart = setTimeout(function tick(){
							PullPointSubscription(cam, devData.id, err => {
								timeoutID.subscribeRestart = setTimeout(tick, 60000);
							});
						}, 100);
					}
				} else {
					adapter.log.warn(`startCameras. This Camera/NVT ${devData.id} does not support PullPoint Events or subscribeEvents = false`);
				}
			})
        }
    } catch (e) {
		adapter.log.error("startCameras: " + e);  
	}
}

function camEvents(devId, camMessage) {
	// Extract Event Details
	// Events have a Topic
	// Events have (optionally) a Source, a Key and Data fields
	// The Source,Key and Data fields can be single items or an array of items
	// The Source,Key and Data fields can be of type SimpleItem or a Complex Item

	//    - Topic
	//    - Message/Message/$
	//    - Message/Message/Source...
	//    - Message/Message/Key...
	//    - Message/Message/Data/SimpleItem/[index]/$/name   (array of items)
	// OR - Message/Message/Data/SimpleItem/$/name   (single item)
	//    - Message/Message/Data/SimpleItem/[index]/$/value   (array of items)
	// OR - Message/Message/Data/SimpleItem/$/value   (single item)
	//adapter.log.debug(`camEvents (${devId}): camMessage = ${JSON.stringify(camMessage)}`);

	let eventTopic = camMessage.topic._
	eventTopic = stripNamespaces(eventTopic);

	let eventTime = camMessage.message.message.$.UtcTime;

	let eventProperty = camMessage.message.message.$.PropertyOperation;
	// Supposed to be Initialized, Deleted or Changed but missing/undefined on the Avigilon 4 channel encoder

	// Only handle simpleItem
	// Only handle one 'source' item
	// Ignore the 'key' item  (nothing I own produces it)
	// Handle all the 'Data' items

	// SOURCE (Name:Value)
	let sourceName = null;
	let sourceValue = null;
	if (camMessage.message.message.source && camMessage.message.message.source.simpleItem) {
		if (Array.isArray(camMessage.message.message.source.simpleItem)) {
			sourceName = camMessage.message.message.source.simpleItem[0].$.Name;
			sourceValue = camMessage.message.message.source.simpleItem[0].$.Value;
			//adapter.log.debug("WARNING: Only processing first Event Source item");
		} else {
			sourceName = camMessage.message.message.source.simpleItem.$.Name;
			sourceValue = camMessage.message.message.source.simpleItem.$.Value;
		}
	} else {
		sourceName = null;
		sourceValue = null;
		//adapter.log.debug("WARNING: Source does not contain a simpleItem");
	}
	
	//KEY
	if (camMessage.message.message.key) {
		//adapter.log.debug('NOTE: Event has a Key');
	}

	// DATA (Name:Value)
	if (camMessage.message.message.data && camMessage.message.message.data.simpleItem) {
		if (Array.isArray(camMessage.message.message.data.simpleItem)) {
			for (let x  = 0; x < camMessage.message.message.data.simpleItem.length; x++) {
				let dataName = camMessage.message.message.data.simpleItem[x].$.Name;
				let dataValue = camMessage.message.message.data.simpleItem[x].$.Value;
				processEvent(devId, eventTime, eventTopic, eventProperty, sourceName, sourceValue, dataName, dataValue);
			}
		} else {
			let dataName = camMessage.message.message.data.simpleItem.$.Name;
			let dataValue = camMessage.message.message.data.simpleItem.$.Value;
			processEvent(devId, eventTime, eventTopic, eventProperty, sourceName, sourceValue, dataName, dataValue);
		}
	} else if (camMessage.message.message.data && camMessage.message.message.data.elementItem) {
		//adapter.log.debug("WARNING: Data contain an elementItem");
		let dataName = 'elementItem';
		let dataValue = JSON.stringify(camMessage.message.message.data.elementItem);
		processEvent(devId, eventTime, eventTopic, eventProperty, sourceName, sourceValue, dataName, dataValue);
	} else {
		//adapter.log.debug("WARNING: Data does not contain a simpleItem or elementItem")
		let dataName = null;
		let dataValue = null;
		processEvent(devId, eventTime, eventTopic, eventProperty, sourceName, sourceValue, dataName, dataValue);
	}	
	
}

function stripNamespaces(topic) {
    // example input :-   tns1:MediaControl/tnsavg:ConfigurationUpdateAudioEncCfg 
    // Split on '/'
    // For each part, remove any namespace
    // Recombine parts that were split with '.'
    let output = '';
    let parts = topic.split('/');
    for (let index = 0; index < parts.length; index++) {
        let stringNoNamespace = parts[index].split(':').pop() // then return the last item in the array
        if (output.length == 0) {
            output += stringNoNamespace;
        } else {
            output += '.' + stringNoNamespace;
        }
    }
    return output;
}

function processEvent(devId, eventTime, eventTopic, eventProperty, sourceName, sourceValue, dataName, dataValue) {
	let output = `${devId}: `;
	output += `${eventTime.toJSON()} ${eventTopic}`
	if (typeof(eventProperty) !== "undefined") {
		output += ` PROP:${eventProperty}`;
	}
	if (typeof(sourceName) !== "undefined" && typeof(sourceValue) !== "undefined") {
		output += ` SRC:${sourceName}=${sourceValue}`;
	}
	if (typeof(dataName) !== "undefined" && typeof(dataValue) !== "undefined") {
		output += ` DATA:${dataName}=${dataValue}`;
	}
	
	let nameObj = 'message.' + eventTopic.toLowerCase() + '.' + dataName;
	let nameObj2 = 'message.' + eventTopic.toLowerCase() + '.value';
	let data = {};
	data['Value'] = dataValue;
	data['UtcTime'] = eventTime.toJSON();
	
	updateState(devId, nameObj, data, {"type": 'object', "read": true, "write": false});
	updateState(devId, nameObj2, dataValue, {"type": typeof dataValue, "read": true, "write": false});
	adapter.log.debug(output);
}

function updateStateWithTimeout(dev_id, name, value, common, timeout, outValue) {
    updateState(dev_id, name, value, common);
    setTimeout(() => updateState(dev_id, name, outValue, common), timeout);
}

function updateState(devId, name, value, common) {
    let id = devId + '.' + name;
	common.name = id;
    adapter.setObjectNotExists(id, {type: 'state', common: common}, (err, obj) => {
        if (err) adapter.log.error(`Cannot write object ID: ${id} - ERROR: ${err}`);
        //adapter.log.info('id=' + JSON.stringify(id));
        //adapter.log.info('value=' + JSON.stringify(value));
        //adapter.log.info('common=' + JSON.stringify(common));
        if (value !== undefined){
            adapter.setState(id, {val: value, ack: true}, (err, id) => {
				if (err) adapter.log.error('Cannot set value for "' + id + '": ' + err);
			});
        }
    });
}

function clearTimeouts(){
	for (let key in timeoutID){
		clearTimeout(timeoutID[key]);
		timeoutID[key] = setTimeout(() => {delete timeoutID[key]}, 10);
	}
}

function deleteDevice(msg, callback) {
    var id = msg.id,
        devId = id.replace(adapter.namespace+'.', '');
    adapter.log.warn('Deleted camera/NVT: ' + devId);
	clearTimeouts();

	adapter.getStatesOf(devId, (err, states) => {
		if (!err && states) {
			states.forEach(state => {
				adapter.delObject(state._id);
			});
		}
		adapter.deleteDevice(devId, err => {
			startCameras();
			callback(err);
		});
	});
}


function getDevicesAdmin(callback){
    var rooms;
	
	adapter.log.debug('getDevicesAdmin');
    adapter.getEnums('enum.rooms', (err, list) => {
        if (!err){
            rooms = list['enum.rooms'];
        }
        adapter.getDevices((err, result) => {
            if (result) {
                var devices = [], cnt = 0, len = result.length;
                for (var item in result) {
                    if (result[item]._id) {
                        var id = result[item]._id.substr(adapter.namespace.length + 1);
                        let devInfo = result[item];
                        devInfo.rooms = [];
                        for (var room in rooms) {
                            if (!rooms[room] || !rooms[room].common || !rooms[room].common.members)
                                continue;
                            if (rooms[room].common.members.indexOf(devInfo._id) !== -1) {
                                devInfo.rooms.push(rooms[room].common.name);
                            }
                        }
                        cnt++;
                        devices.push(devInfo);
                        if (cnt==len) {
                            adapter.log.debug('getDevicesAdmin result: ' + JSON.stringify(devices));
							callback(devices);
                        }
                    }
                }
                if (len == 0) {
                    adapter.log.debug('getDevicesAdmin result: ' + JSON.stringify(devices));
                    callback(devices);
                }
            }
        });
    });
}

const discoveryClassCam = (ip_entry, user, password, port_entry) => new Promise((resolve) => {
	let devices = {};
	adapter.log.debug('discoveryClassCam: ' + ip_entry + ':' + port_entry);
	new MyCam({
		hostname: ip_entry,
		username: user,
		password: password,
		port: port_entry,
		timeout : 15000,
		preserveAddress: true
	}, function CamFunc(err) {
		if (err) {
			adapter.log.error('CamFunc: ' + ip_entry + ':' + port_entry + ' - ' + err);
			return resolve(devices);
		}
		let cam_obj = this;
		adapter.log.debug('cam_obj: ' + JSON.stringify(cam_obj));
		let sub_obj = [];
		let got_date;
		let got_info;
		let got_live_stream_tcp;
		let got_live_stream_udp;
		let got_live_stream_multicast;
		let got_recordings;
		let got_replay_stream;
		let hasEvents = false;
		let hasTopics = false;

		// Use Nimble to execute each ONVIF function in turn
		// This is used so we can wait on all ONVIF replies before
		// writing to the console
		flow.series([
			function(callback) {
				cam_obj.getSystemDateAndTime((err, date, xml) => {
					if (err) adapter.log.error(cam_obj.hostname + " getSystemDateAndTime: " + err);
					if (!err) {adapter.log.debug(cam_obj.hostname + ' Device Time   ' + date);}
					if (!err) got_date = date;
					callback();
				});
			},
			function(callback) {
				cam_obj.getDeviceInformation((err, info, xml) => {
					if (err) adapter.log.error(cam_obj.hostname + " getDeviceInformation: " + err);
					if (!err) {adapter.log.debug(cam_obj.hostname + ' Manufacturer  ' + info.manufacturer);}
					if (!err) {adapter.log.debug('Model         ' + info.model);}
					if (!err) {adapter.log.debug('Firmware      ' + info.firmwareVersion);}
					if (!err) {adapter.log.debug('Serial Number ' + info.serialNumber);}
					if (!err) got_info = info;
					callback();
				});
			},
			function(callback) {
				cam_obj.getCapabilities((err, data, xml) => {
					if (err) adapter.log.error(cam_obj.hostname + " getCapabilities: " + err);
					if (!err && data.events && data.events.WSPullPointSupport && data.events.WSPullPointSupport == true) {
						adapter.log.info(cam_obj.hostname + ' Camera supports WSPullPoint');
						hasEvents = true;
					} else {
						adapter.log.warn(cam_obj.hostname + ' Camera does not show WSPullPoint support, but trying anyway');
						// Have an Axis cameras that says False to WSPullPointSuppor but supports it anyway
						hasEvents = false; // Hack for Axis cameras
					}

					if (hasEvents == false) {
						adapter.log.warn(cam_obj.hostname + ' This camera/NVT does not support PullPoint Events');
					}
					callback();
				})
			},
			function(callback) {
				if (hasEvents) {
					cam_obj.getEventProperties((err, data, xml) => {
						if (err) {
							adapter.log.error(cam_obj.hostname + " getEventProperties: " + err);
						} else {
							// Display the available Topics
							let parseNode = (node, topicPath) => {
								// loop over all the child nodes in this node
								for (const child in node) {
									if (child == "$") {continue;} else if (child == "messageDescription") {
										// we have found the details that go with an event
										// examine the messageDescription
										let IsProperty = false;
										let source = '';
										let data = '';
										let dataName;
										let dataType;
										if (node[child].$ && node[child].$.IsProperty) {IsProperty = node[child].$.IsProperty}
										if (node[child].source) {source = JSON.stringify(node[child].source)}
										if (node[child].data) {data = JSON.stringify(node[child].data)}
										adapter.log.debug(cam_obj.hostname + ' Found Event - ' + topicPath.toUpperCase())
										adapter.log.debug(cam_obj.hostname + '  IsProperty=' + IsProperty);
										if (source.length > 0) {adapter.log.debug(cam_obj.hostname + '  Source=' + source);}
										if (data.length > 0) {adapter.log.debug(cam_obj.hostname + '  Data=' + data);}
										if (IsProperty) {
											if (node[child].data.simpleItemDescription.$.hasOwnProperty('Name')) {
												dataName = node[child].data.simpleItemDescription.$.Name;
											}
											if (node[child].data.simpleItemDescription.$.hasOwnProperty('Type')) {
												dataType = node[child].data.simpleItemDescription.$.Type.substr(3);
											}
											topicPath = topicPath.toLowerCase();
											sub_obj.push({
												nameObj: topicPath.substr(1).split("/").join("."),
												nameValue: dataName,
												nameType: dataType
											});
											hasTopics = true;
										}
										return
									} else {
										// decend into the child node, looking for the messageDescription
										parseNode(node[child], topicPath + '/' + child)
									}
								}
							}
							parseNode(data.topicSet, '')
						}
						adapter.log.info(cam_obj.hostname + " sub_obj: " + JSON.stringify(sub_obj));
						callback()
					});
				} else {
					callback()
				}
			},	
			function(callback) {
				try {
					cam_obj.getStreamUri({
						protocol: 'RTSP',
						stream: 'RTP-Unicast'
					}, (err, stream, xml) => {
						if (err) adapter.log.error(cam_obj.hostname + " getStreamUri (RTSP): " + err);
						if (!err) got_live_stream_tcp = stream;
						callback();
					});
				} catch(err) {callback();}
			},
			function(callback) {
				try {
					cam_obj.getStreamUri({
						protocol: 'UDP',
						stream: 'RTP-Unicast'
					}, (err, stream, xml) => {
						if (err) adapter.log.error(cam_obj.hostname + " getStreamUri (UDP): " + err);
						if (!err) got_live_stream_udp = stream;
						callback();
					});
				} catch(err) {callback();}
			},
			function(callback) {
				try {
					cam_obj.getStreamUri({
						protocol: 'UDP',
						stream: 'RTP-Multicast'
					}, (err, stream, xml) => {
						if (err) adapter.log.error(cam_obj.hostname + " getStreamUri (RTP-Multicast): " + err);
						if (!err) got_live_stream_multicast = stream;
						callback();
					});
				} catch(err) {callback();}
			},
			function(callback) {
				try {
					cam_obj.getPresets({}, // use 'default' profileToken
						// Completion callback function
						// This callback is executed once we have a list of presets
						(err, stream, xml) => {
							if (err) {
								adapter.log.error(cam_obj.hostname + " GetPreset Error " + err);
								//return;
								callback();
							} else {
								// loop over the presets and populate the arrays
								// Do this for the first 9 presets
								adapter.log.info(cam_obj.hostname + " GetPreset Reply: " +  + JSON.stringify(stream));
								//let count = 1;
								//for(let item in stream) {
								//	let name = item;          //key
								//	let token = stream[item]; //value
								//	// It is possible to have a preset with a blank name so generate a name
								//	if (name.length == 0) name = 'no name (' + token + ')';
								//	preset_names.push(name);
								//	preset_tokens.push(token);

								//	// Show first 9 preset names to user
								//	if (count < 9) {
								//		adapter.log.warn('Press key ' + count + ' for preset "' + name + '"');
								//	count++;
								//	}
								//}
								callback();
							}
						}
					);
				} catch(err) {callback();}
			},
			function(callback) {
				cam_obj.getConfigurations((err, data, xml) => {
					if (err) adapter.log.error(cam_obj.hostname + " getConfigurations: " + err);
					if (!err) adapter.log.info(cam_obj.hostname + " getConfigurations: " +  + JSON.stringify(data));
					callback();
				});
			},
			function(callback) {
				cam_obj.getNodes((err, data, xml) => {
					if (err) adapter.log.error(cam_obj.hostname + " getNodes: " + err);
					if (!err) adapter.log.info(cam_obj.hostname + " getNodes: " +  + JSON.stringify(data));
					callback();
				});
			},
			/*function(callback) {
				cam_obj.getRecordings((err, recordings, xml) => {
					if (err) adapter.log.error(cam_obj.hostname + " getRecordings: " + err);
					if (!err) got_recordings = recordings;
					callback();
				});
			},
			function(callback) {
				// Get Recording URI for the first recording on the NVR
				if (got_recordings) {
					adapter.log.info(cam_obj.hostname + ' got_recordings='+JSON.stringify(got_recordings));
					if (Array.isArray(got_recordings)) {
						got_recordings = got_recordings[0];
					}
					cam_obj.getReplayUri({
						protocol: 'RTSP',
						recordingToken: got_recordings.recordingToken
					}, (err, stream, xml) => {
						if (err) adapter.log.error(cam_obj.hostname + " getReplayUri: " + err);
						if (!err) got_replay_stream = stream;
						callback();
					});
				} else {
					callback();
				}
			},*/
			function(callback) {
				adapter.log.info('------------------------------');
				adapter.log.info('Host: ' + ip_entry + ' Port: ' + port_entry);
				adapter.log.info('Date: = ' + got_date);
				adapter.log.info('Info: = ' + JSON.stringify(got_info));
				if (got_live_stream_tcp) {
					adapter.log.debug('First Live TCP Stream: =       ' + got_live_stream_tcp.uri);
				}
				if (got_live_stream_udp) {
					adapter.log.debug('First Live UDP Stream: =       ' + got_live_stream_udp.uri);
				}
				if (got_live_stream_multicast) {
					adapter.log.debug('First Live Multicast Stream: = ' + got_live_stream_multicast.uri);
				}
				//if (got_replay_stream) {
				//	adapter.log.debug('First Replay Stream: = ' + got_replay_stream.uri);
				//} else got_replay_stream = '';
				
				adapter.log.debug('capabilities: ' + JSON.stringify(cam_obj.capabilities));
				adapter.log.info('------------------------------');
				
				/*if (!adapter.supportsFeature || !adapter.supportsFeature('ADAPTER_AUTO_DECRYPT_NATIVE')) {
					secret = (systemConfig && systemConfig.native && systemConfig.native.secret) || 'Zgfr56gFe87jJOM';
					password = tools.encrypt(secret, password);
				}*/
				
				devices = {
					id: getId(ip_entry+':'+port_entry),
					name: ip_entry+':'+port_entry,
					ip: ip_entry,
					port: port_entry,
					user: user,
					password: password,
					ip: ip_entry,
					cam_date: got_date,
					info: got_info,
					events: hasTopics,
					subscribeEvents: hasTopics,
					live_stream_tcp: got_live_stream_tcp,
					live_stream_udp: got_live_stream_udp,
					live_stream_multicast: got_live_stream_multicast,
					//replay_stream: got_replay_stream,
					sub_obj: sub_obj
				};
				callback();
			}
		], 
		function(err, results){
			if (err) adapter.log.error('flow.series  err = ' + err);
			adapter.log.debug('flow.series  devices = ' + JSON.stringify(devices));
			return resolve(devices);
		}); // end flow
	});
});

async function discovery(options) {
	adapter.log.debug('discovery start');
	try{
		if (isDiscovery) {
			return ('Yet running');
		}
		isDiscovery = true;
		adapter.setState('discoveryRunning', true, true);
		
		let start_range = options.start_range || adapter.config.start_range,  	//'192.168.1.1'
			end_range = options.end_range || adapter.config.end_range,  	  	//'192.168.1.254'
			port_list = options.ports || adapter.config.ports;
			port_list = port_list.split(',').map(item => item.trim());
		let user = options.user || adapter.config.user,  						// 'admin'
			password = options.password || adapter.config.password;  			// 'admin'
		adapter.log.warn('password = ' + password);
		let ip_list;
		if (adapter.config.autostartDiscovery){
			adapter.log.debug('adapter.config.ip_list: ' + adapter.config.ip_list);
			ip_list = adapter.config.ip_list;
		} else {
			ip_list = generate_range(start_range, end_range);
			if (ip_list.length === 1 && ip_list[0] === '0.0.0.0') {
				ip_list = [options.start_range];
			}
		}
		
		adapter.log.debug('ip_list = ' + JSON.stringify(ip_list));
		return await Promise.all(
			ip_list.map(async(ip_entry) => {
				let devices = {};
				adapter.log.debug('ip_list.map start ip_entry: ' + ip_entry);
				adapter.log.debug('ip_list.map start user: ' + user);
				adapter.log.debug('ip_list.map start passowrd: ' + password);
				
				for (let port_entry of port_list){
					let result = await discoveryClassCam(ip_entry, user, password, port_entry);
					adapter.log.debug(`discoveryClassCam: ${ip_entry}:${port_entry} - result: ${JSON.stringify(result)}`);
					if (Object.keys(result).length > 0) devices = result;
				}
				adapter.log.debug('ip_list.map result: ' + JSON.stringify(devices));
				return devices;
			})
		)
	} catch(err) {
		adapter.log.error('discovery: ' + err);
		return err;
	}
}

async function processScannedDevices(devices) {
    // check if device is newInstances
	adapter.log.debug('processScannedDevices');
    return new Promise((resolve, reject) => {adapter.getDevices(async(err, result) => {
			let newInstances = [];
			let currDevs = [];
			if (err) {
				adapter.log.error(" processScannedDevices. getDevices: " + err);
				return reject(err);
			} else {
				adapter.log.debug('processScannedDevices. result = ' + JSON.stringify(result));
				result.forEach(item => {
					if (item._id) {
						currDevs.push(item.native.id);
					}
				});
				adapter.log.debug('processScannedDevices. currDevs = ' + JSON.stringify(currDevs));
				adapter.log.debug('processScannedDevices. devices = ' + JSON.stringify(devices));
				for (let dev of devices){
					adapter.log.debug('processScannedDevices. dev = ' + JSON.stringify(dev));
					if (dev.id) {
						adapter.log.debug('processScannedDevices. currDevs.indexOf(dev.id) = ' + currDevs.indexOf(dev.id));
						if (currDevs.indexOf(dev.id) == -1) {
							newInstances.push(dev);
							let sub_obj = dev.sub_obj;
							delete dev.sub_obj;
							let str = await updateDev(dev.id, dev.name, dev, sub_obj);
							adapter.log.debug('processScannedDevices ' + str);
						}
					}
				}
				adapter.log.debug('processScannedDevices FINISH');
				return resolve(newInstances);
			} 
		});
	});
}


async function updateDev(dev_id, dev_name, devData, sub_obj) {
    // create dev
    adapter.log.debug('создать dev_id: ' + JSON.stringify(dev_id));
    adapter.log.debug('создать devData: ' + JSON.stringify(devData));
	adapter.log.debug('создать sub_obj: ' + JSON.stringify(sub_obj));
    return new Promise((resolve, reject) => {
		adapter.createDevice(dev_id, {}, devData, (err, obj) => {
			if (err) {
				adapter.log.error('Cannot write object: ' + err);
				reject(err);
			}
					
			sub_obj.forEach(item => {
				let nameTopic = dev_id + '.message.' + item.nameObj;
				let value;
				
				if (item.nameType === 'boolean') value = false;
				if (item.nameType === 'string') value = '';
				if (item.nameType === 'int') value = 0;
				let data = {};
				data['Value'] = value;
				data['UtcTime'] = '';
				
				updateState(nameTopic, item.nameValue, data, {"type": 'object', "read": true, "write": false});
				updateState(nameTopic, 'value', value, {"type": typeof value, "read": true, "write": false});
				adapter.log.debug('updateDev. updateState = ' + JSON.stringify(nameTopic));
			});
			updateState(dev_id, 'subscribeEvents', devData.subscribeEvents, {"type": "boolean", "read": true, "write": true});
			updateState(dev_id, 'connection', false, {"type": "boolean", "read": true, "write": false});
			adapter.log.debug('updateDev. resolve = OK');
			resolve("OK");
		});
	});
}


function getId(addr) {
    return addr.replace(/\./g, '_').replace(':', '_');
}


function generate_range(start_ip, end_ip) {
    var start_long = toLong(start_ip);
    var end_long = toLong(end_ip);
    if (start_long > end_long) {
        var tmp=start_long;
        start_long=end_long
        end_long=tmp;
    }
    var range_array = [];
    var i;
    for (i=start_long; i<=end_long;i++) {
        range_array.push(fromLong(i));
    }
    return range_array;
}


//toLong taken from NPM package 'ip'
function toLong(ip) {
    var ipl = 0;
    ip.split('.').forEach(function(octet) {
        ipl <<= 8;
        ipl += parseInt(octet);
    });
    return(ipl >>> 0);
};


//fromLong taken from NPM package 'ip'
function fromLong(ipl) {
    return ((ipl >>> 24) + '.' +
        (ipl >> 16 & 255) + '.' +
        (ipl >> 8 & 255) + '.' +
        (ipl & 255) );
};

function startDiscovery(options, callback){
	adapter.log.info('Discovery starting...');
	discovery(options)
	.then(async(devices) => {
		adapter.log.debug('Discovery devices: ' + JSON.stringify(devices));
		devices = devices.filter(cam => {
			return Object.keys(cam).length > 0;
		});				
		try {
			if (devices.length > 0) await processScannedDevices(devices);
		} catch (err) {
			adapter.log.debug('Discovery. error: ' + error);
		}
		isDiscovery = false;
		adapter.log.info('Discovery finished');
		startCameras();
		adapter.setState('discoveryRunning', { val: false, ack: true });
		callback && callback(devices);
	});
}

function startAdapter(options) {
    // Create the adapter and define its methods
    return adapter = utils.adapter(Object.assign({}, options, {
        name: 'onvif',

        // The ready callback is called when databases are connected and adapter received configuration.
        // start here!
        ready: () => {
			adapter.getForeignObject('system.config', (err, systemConfig) => {
				/*if (adapter.config.password && (!adapter.supportsFeature || !adapter.supportsFeature('ADAPTER_AUTO_DECRYPT_NATIVE'))) {
					secret = (systemConfig && systemConfig.native && systemConfig.native.secret) || 'Zgfr56gFe87jJOM';
					if (!adapter.config.autostartDiscovery) adapter.config.password = tools.decrypt(secret, adapter.config.password);
				}
				if ((/[\x00-\x08\x0E-\x1F\x80-\xFF]/.test(adapter.config.password))&&(!adapter.config.autostartDiscovery)) {
					adapter.log.error('Password error: Please re-enter the password in Admin. Stopping');
				//	return;
				}*/
				
				main(); // Main method defined below for readability
			});
		},

        // is called when adapter shuts down - callback has to be called under any circumstances!
        unload: (callback) => {
            try {
				clearTimeouts();
				if (isDiscovery) {
					//adapter && adapter.setState && adapter.setState('discoveryRunning', false, true);
					adapter.setState('discoveryRunning', { val: false, ack: true });
					isDiscovery = false;
				}
                adapter.log.debug('cleaned everything up...');
                callback();
            } catch (e) {
                callback();
            }
        },

        // is called if a subscribed object changes
        objectChange: (id, obj) => {
            if (obj) {
                // The object was changed
                adapter.log.debug(`object ${id} changed: ${JSON.stringify(obj)}`);
            } else {
                // The object was deleted
                adapter.log.debug(`object ${id} deleted`);
            }
        },

        // is called if a subscribed state changes
        stateChange: (id, state) => {
            if (state) {
                // The state was changed
                adapter.log.debug(`state ${id} changed: ${JSON.stringify(state.val)} (ack = ${state.ack})`);
				if (!state.ack){
					const devId = adapter.namespace + '.' + id.split('.')[2]; // iobroker device id
					adapter.log.debug("devId = " + devId);
				}
            } else {
                // The state was deleted
                adapter.log.debug(`state ${id} deleted`);
            }
        },

        // Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
        // requires "common.message" property to be set to true in io-package.json
        message: (obj) => {
         	if (typeof obj === 'object' && obj.message) {
         		if (obj.command === 'discovery') {
					// e.g. send email or pushover or whatever
					adapter.log.debug('Received "discovery" event');
					clearTimeouts();
					startDiscovery(obj.message, result => {
						if (obj.callback) setTimeout(() => {adapter.sendTo(obj.from, obj.command, result, obj.callback)}, 500);
					});
				}
				if (obj.command === 'getDevices') {
					adapter.log.debug('Received "getDevices" event');
					getDevicesAdmin(devices => {
						adapter.sendTo(obj.from, obj.command, devices, obj.callback);
					});
				}
				if (obj.command === 'deleteDevice') {
					adapter.log.warn('Received "deleteDevice" event (message: ' + JSON.stringify(obj.message) + ')');
					deleteDevice(obj.message, (err) => {
						if (obj.callback) setTimeout(() => {adapter.sendTo(obj.from, obj.command, err, obj.callback)}, 500);
					});
				}
				if (obj.command === 'getSnapshot') {
					adapter.log.debug('Received "getSnapshot" event (message: ' + JSON.stringify(obj.message) + ')');
					getSnapshot(obj.message, (error, img) => {
						adapter.sendTo(obj.from, obj.command, {'img': img, 'err': error}, obj.callback);
						//if (!error) adapter.sendTo(obj.from, obj.command, img, obj.callback);
						//if ((error)&&(error === 'not ready')) adapter.sendTo(obj.from, obj.command, error, obj.callback);
					});
				}
				if (obj.command === 'saveFileSnapshot') {
					adapter.log.debug('Received "saveFileSnapshot" event (message: ' + JSON.stringify(obj.message) + ')');
					saveFileSnapshot(obj.message, (error, img) => {
						if (!error) adapter.sendTo(obj.from, obj.command, img, obj.callback);
					});
				}
				if (obj.command === 'getSettingsCamera') {
					adapter.log.debug('Received "getSettingsCamera" event (message: ' + JSON.stringify(obj.message) + ')');
					getSettingsCamera(obj.message, (settings) => {
						adapter.sendTo(obj.from, obj.command, settings, obj.callback);
					});
				}
				if (obj.command === 'setChangeCam') {
					adapter.log.debug('Received "setChangeCam" event (message: ' + JSON.stringify(obj.message) + ')');
					setChangeCam(obj.message, (change) => {
						adapter.sendTo(obj.from, obj.command, change, obj.callback);
					});
				}
         	}
        },
    }));
}

function main() {
    // in this template all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');
	
	adapter.setState('discoveryRunning', { val: false, ack: true });
	
	if (adapter.config.autostartDiscovery){
		adapter.log.info('Autostart discovery!');
		startDiscovery({});
		
		let password = adapter.config.password;
		/*if (!adapter.supportsFeature || !adapter.supportsFeature('ADAPTER_AUTO_DECRYPT_NATIVE')) {
			secret = (systemConfig && systemConfig.native && systemConfig.native.secret) || 'Zgfr56gFe87jJOM';
			password = tools.encrypt(secret, adapter.config.password);
		} else {
			password = adapter.config.password;
		}*/
		
		adapter.updateConfig({
			autostartDiscovery: false,
			password: password
		}, result => {
			adapter.log.warn('err: ' + JSON.stringify(result));
		});
	} else {
		startCameras();
	}
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export startAdapter in compact mode
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly
    startAdapter();
}