var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var Q = require('q');
var debug = require('debug')('bot');
var inherits = require('util').inherits;
var validator = require('validator');
var request = require('request');
var ini = require('ini');
var sc = require("statuscode");
var HTTPStatusCode = require('http-status-code');
var config = ini.parse(fs.readFileSync(path.join(__dirname, 'conf.ini'), 'utf-8'));
var WXBot = require('./wxbot');

function TulingWXBot(options) {
    WXBot.apply(this, Array.prototype.slice.call(arguments));

    this.tulingKey = config.main.key;
    this.robotSwitch = true;
}

inherits(TulingWXBot, WXBot);


// basic request callback
function _brc(cb) {
    return function(err, response, data) {
        if (err) return cb(err);
        var statusCode = response.statusCode;
        if (sc.accept(statusCode, 2)) {
            cb(null, data);
        } else {
            cb(new WXBotError('', statusCode + ' - ' + HTTPStatusCode.getMessage(statusCode)));
        }
    }
}


TulingWXBot.prototype.tulingAutoReply = function(uid, msg, cb) {
    var self = this;
    if (self.DEBUG) console.log('[DEBUG] TulingAutoReply uid = %s, msg = %s', uid, msg);

    Q()
        .then(function() {
            var deferred = Q.defer();
            if (self.tulingKey && !validator.isNull(self.tulingKey)) {
                var url = 'http://www.tuling123.com/openapi/api';
                var userId = uid.replace('@', '').substring(0, 30);
                var body = {
                    key: self.tulingKey,
                    info: msg,
                    userid: userId
                };

                self.request.post(url, {
                    form: body,
                    json: true,
                    jsonReviver: true
                }, _brc(function(err, data) {
                    if (err) return deferred.reject(err);
                    console.log(err, data);
                    console.log(typeof data);
                    var result;
                    if (data.code === 100000) {
                        result = _.replace(data.text, /<br\s*[\/]?>/gi, '  ');
                    } else if (data.code === 200000) {
                        result = data.url;
                    } else {
                        result = _.replace(data.text, /<br\s*[\/]?>/gi, '  ');
                    }
                    deferred.resolve(result);
                }));
            } else {
                deferred.resolve('知道了0.0');
            }
            return deferred.promise;
        }).then(function(result) {
            if (self.DEBUG) console.log('[DEBUG] TulingAutoReply result = %s', result);
            cb(null, result);
        })
        .catch(cb);
}


TulingWXBot.prototype.handleMsgAll = function(msg, cb) {
    var self = this;
    var promise = Q();
    debug('Handler msg All. msg=%o', msg);
    if (msg.msgTypeId === 1 && msg.content.type === 0) {
        // reply to self
    } else if (msg.msgTypeId === 4 && msg.content.type === 0) {
        promise = promise.then(function() {
                return Q.nfcall(self.tulingAutoReply.bind(self), msg.user.id, msg.content.data);
            })
            .then(function(tmsg) {
                tmsg = '[机器人值班中]' + tmsg;
                return Q.nfcall(self.sendMsgByUid.bind(self), tmsg, msg.user.id);
            });
    } else if (msg.msgTypeId === 3 && msg.content.type === 0) {
        // group text message
        var myName;
        if (_.hasIn(msg, 'content.detail')) {
            myName = self.getGroupMemberName(self.myAccount.UserName, msg.user.id);
        }
        debug('myName=%o', myName);
        if (!myName) myName = {};
        if (self.myAccount.NickName)
            myName.nickName2 = self.myAccount.NickName;
        if (self.myAccount.RemarkName)
            myName.remarkName2 = self.myAccount.RemarkName;

        var isAtMe = false;

        for(var i = 0; i < msg.content.detail.length; i++) {
            var detail = msg.content.detail[i];
            debug('detail[%s]=%o', i, detail);
            if (detail.type === 'at') {
                for (var k in myName) {
                    if (myName[k] === detail.value) {
                        isAtMe = true;
                        break;
                    }
                }
            }
        }

        if (isAtMe) {
            var srcName = msg.content.user.name;
            debug('srcName=%s', srcName);
            var reply = 'to ' + srcName + ': ';

            if (msg.content.type === 0) {
                promise = promise.then(function () {
                    return Q.nfcall(self.tulingAutoReply.bind(self), msg.content.user.id, msg.content.desc);
                })
                .then(function (tmsg) {
                    reply += tmsg;
                })
            } else {
                reply += '对不起，只认字，其他杂七杂八的我都不认识0.0';
            }

            promise = promise.then(function() {
                debug('reply=%s', reply);
                return Q.nfcall(self.sendMsgByUid.bind(self), reply, msg.user.id);
            })
        }
    }

    promise.then(function() {
            cb();
        })
        .catch(cb);
}


var bot = new TulingWXBot({
    DEBUG: true
});
bot.run();