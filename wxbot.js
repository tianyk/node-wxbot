// WXBot
// https验证
// http://stackoverflow.com/questions/17383351/how-to-capture-http-messages-from-request-node-library-with-fiddler?answertab=votes#tab-top
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
// require('request').debug = true;

var fs = require('fs');
var path = require('path');
var querystring = require('querystring');
var _ = require('lodash');
var async = require('async');
var Q = require('q');
var iconv = require('iconv-lite');
var request = require('request');
var format = require('format');
var sc = require("statuscode");
var parser = require('xml2json');
var validator = require('validator');
var debug = require('debug')('wxbot');
var HTTPStatusCode = require('http-status-code');
var qrcode = require('qrcode-terminal');
var FileCookieStore = require('tough-cookie-filestore');
var randomstring = require('randomstring');
var inherits = require('util').inherits;

// var j = request.jar();

var UNKONWN = 'unkonwn';
var SUCCESS = '200';
var SCANED = '201';
var TIMEOUT = '408';
var HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux i686; U;) Gecko/20070322 Kazehakase/0.4.5',
    'Connection': 'keep-alive',
    'Accept': '*/*'
};

function WXBotError(code, msg, cause) {
    Error.call(this);
    Error.captureStackTrace(this, WXBotError);
    this.name = 'WXBotError';
    this.code = code || '';
    this.message = msg;
    this.cause = cause;
};

inherits(WXBotError, Error);

WXBotError.prototype.toJSON = function() {
    return JSON.stringify({
        name: this.name,
        code: this.code || '',
        message: this.message,
        cause: this.cause || '',
        stack: this.stack
    });
}


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


function WXBot(opts) {
    // WXBot, a framework to process WeChat messages
    this.DEBUG = opts.DEBUG || false;
    this.uuid = '';
    this.baseURI = '';
    this.redirectURI = '';
    this.uin = '';
    this.sid = '';
    this.skey = '';
    this.passTicket = '';
    this.devideId = 'e' + randomstring.generate({
        length: 15,
        charset: 'numeric'
    });

    // var j = request.jar(new FileCookieStore('cookies.json'));
    var j = request.jar();
    this.session = request.defaults({
        jar: j,
        headers: HEADERS,
        gzip: true,
        // proxy: 'http://127.0.0.1:8888/'
    });
    this.request = request.defaults({
        headers: HEADERS,
        gzip: true,
        // proxy: 'http://127.0.0.1:8888/'
    });

    this.myAccount = {}; // this account

    // all kind of accounts: contacts, public accounts, groups, special accounts
    this.memberList = [];

    // members of all groups, {'group_id1': [member1, member2, ...], ...}
    this.groupMembers = {};

    // all accounts, {'group_member':{'id':{'type':'group_member', 'info':{}}, ...}, 'normal_member':{'id':{}, ...}}
    this.accountInfo = {
        'groupMember': {},
        'normalMember': {}
    };

    this.contactList = []; // contact list
    this.publicList = []; // public account list
    this.groupList = []; // group chat list
    this.specialList = []; // special list account
}


WXBot.prototype.getUUID = function(cb) {
    var self = this;

    var url = 'https://login.weixin.qq.com/jslogin';
    var params = {
        'appid': 'wx782c26e4c19acffb',
        'fun': 'new',
        'lang': 'zh_CN',
        '_': _.now()
    }
    var regx = /window.QRLogin.code = (\d+); window.QRLogin.uuid = "(\S+?)"/;
    self.session.get({
        url: url,
        qs: params
    }, _brc(function(err, data) {
        if (err) return cb(err);

        if (self.DEBUG) console.log('[DEBUG] getUUID: ' + data);

        var param = data.match(regx);
        if (param) {
            var code = param[1];
            self.uuid = param[2];
            cb(null, code === '200');
        } else {
            cb(null, false);
        }
    }));
}


WXBot.prototype.genQRCode = function(cb) {
    var self = this;
    var str = 'https://login.weixin.qq.com/l/' + this.uuid;
    if (self.DEBUG) console.log('[DEBUG] qrcode url: ' + str);
    qrcode.generate(str, function(qrcode) {
        console.log(qrcode);
        return cb();
    });
}


WXBot.prototype.doRequest = function(url, cb) {
    var self = this;
    if (self.DEBUG) console.log('[DEBUG] doRequest url: ' + url);
    self.session.get(url, _brc(function(err, data) {
        if (err) return cb(err);

        var param = data.match(/window.code=(\d+);/);
        if (param) {
            var code = param[1];
            return cb(null, code, data);
        } else {
            return cb(null, UNKONWN, data);
        }
    }));
}


// http comet:
// tip=1, the request wait for user to scan the qr,
//        201: scaned
//        408: timeout
// tip=0, the request wait for user confirm,
//        200: confirmed
WXBot.prototype.wait4login = function(cb) {
    var self = this;
    //TODO https://login.weixin.qq.com/cgi-bin/mmwebwx-bin/login?loginicon=true&uuid=Ab7Ao2SO_g==&tip=0&r=783335570&_=1459505497707
    var LOGIN_TEMPLATE = 'https://login.weixin.qq.com/cgi-bin/mmwebwx-bin/login?tip=%s&uuid=%s&_=%s';
    var tip = 1;
    var skip = false;

    var tryLaterSecs = 1 * 1000;
    var MAX_RETRY_TIMES = 10;

    var code = UNKONWN;

    // TODO 待修复响应时间过大重复回调Bug.
    var retryTime = MAX_RETRY_TIMES;
    var timer = setInterval(function() {
        if (skip) return;
        skip = true;

        // 失败(超时、无法匹配)重试
        if (retryTime <= 0) {
            clearInterval(timer);
            return cb(new WXBotError('', '[ERROR] Login timeout.'));
        }

        var url = format(LOGIN_TEMPLATE, tip, self.uuid, parseInt(_.now() / 1000));
        self.doRequest(url, function(err, code, data) {
            if (err) {
                clearInterval(timer);
                return cb(err);
            }

            if (code === SCANED) {
                console.log('[INFO] Please confirm to login .');
                tip = 0;
            } else if (code === SUCCESS) {
                clearInterval(timer);
                // confirmed sucess
                var param = data.match(/window.redirect_uri="(\S+?)";/);
                if (param) {
                    var redirectURI = param[1] + '&fun=new';
                    if (self.DEBUG) console.log('[DEBUG] RedirectURI = %s', redirectURI);
                    self.redirectURI = redirectURI;
                    self.baseURI = redirectURI.substring(0, redirectURI.lastIndexOf('/'));
                    return cb(null, code);
                } else {
                    return cb(new WXBotError('', '[ERROR] Not match(wait4login).'));
                }

            } else if (code === TIMEOUT) {
                console.log('[ERROR] WeChat login timeout. retry in %s secs later...', tryLaterSecs);
                retryTime -= 1;
            } else {
                console.log('[ERROR] WeChat login exception return_code=%s. retry in %s secs later...', code, tryLaterSecs);
                tip = 1; // #need to reset tip, because the server will reset the peer connection
                retryTime -= 1;
            }

            skip = false;
        })
    }, tryLaterSecs);
}


WXBot.prototype.login = function(cb) {
    var self = this;
    if (self.redirectURI.length < 4) {
        console.log('[ERROR] Login failed due to network problem, please try again.');
        return cb(new WXBotError('', '[ERROR] Login failed due to network problem, please try again.'));
    }

    if (self.DEBUG) console.log('[DEBUG] Login redirectURI = %s', self.redirectURI);
    self.session.get(self.redirectURI, _brc(function(err, data) {
        if (err) return cb(err);
        // <error>
        //     <ret>0</ret>
        //     <message>OK</message>
        //     <skey>@crypt_7a8e5b0d_e97b66fe127dc0a530a4a88ece958b6f</skey>
        //     <wxsid>jOUpyQ3LgxxSkDHO</wxsid>
        //     <wxuin>2942444582</wxuin>
        //     <pass_ticket>iEWUGAON52yB4X1T0RywbNSbfn09HQXw0I4YBuG5Ap%2FCV7ijpdc8%2F%2FAfq6aJyHlw</pass_ticket>
        //     <isgrayscale>1</isgrayscale>
        // </error>
        if (self.DEBUG) console.log('[DEBUG] Login response data = %s', data);
        try {
            data = parser.toJson(data, {
                object: true
            });
        } catch (e) {
            return cb(e);
        }
        data = data.error;
        if (data.ret !== '0') return cb(new WXBotError('', format('[ERROR] Web WeChat login failed. ret = %s, message = %s', data.ret, data.message)));

        self.skey = data.skey || '';
        self.sid = data.wxsid || '';
        self.uin = data.wxuin || '';
        self.passTicket = data.pass_ticket || '';

        if (validator.isNull(self.skey) || validator.isNull(self.sid) || validator.isNull(self.uin) || validator.isNull(self.passTicket))
            return cb(new WXBotError('', format('[ERROR] Web WeChat login failed. skey = %s, sid = %s, uin = %s, passTicket = %s', self.skey, self.sid, self.uin, self.passTicket)));

        self.baseRequest = {
            'Uin': self.uin,
            'Sid': self.sid,
            'Skey': self.skey,
            'DeviceID': self.devideId
        };

        console.log('[INFO] Web WeChat login succeed .');
        cb();
    }));
}


WXBot.prototype.init = function(cb) {
    var self = this;
    var url = format(self.baseURI + '/webwxinit?r=%d&lang=en_US&pass_ticket=%s', parseInt(_.now() / 1000), self.passTicket);
    var params = {
        'BaseRequest': self.baseRequest
    };

    if (self.DEBUG) console.log('[DEBUG] Login init url = %s', url);
    if (self.DEBUG) console.log('[DEBUG] Login init params = %s', params);

    self.session.post({
        url: url,
        body: params,
        json: true,
        jsonReviver: true
    }, _brc(function(err, data) {
        if (err) return cb(err);
        if (self.DEBUG) console.log('[DEBUG] Web WeChat init response data = %s', data);

        if (data.BaseResponse.Ret !== 0)
            return cb(new WXBotError('', format('[ERROR] Web WeChat init failed. ret = %s, message = %s', data.BaseResponse.Ret, data.BaseResponse.ErrMsg)));

        self.syncKey = data.SyncKey;
        self.myAccount = data.User;
        self.syncKeyStr = _.chain(self.syncKey.List)
            .map(function(keyVal) {
                return keyVal.Key + '_' + keyVal.Val;
            })
            .join('|')
            .value();

        console.log('[INFO] Web WeChat init succeed .');
        cb();
    }));
}


WXBot.prototype.statusNotify = function(cb) {
    var self = this;

    var url = format(self.baseURI + '/webwxstatusnotify?lang=zh_CN&pass_ticket=%s', self.passTicket);

    var params = {
        'BaseRequest': self.baseRequest,
        "Code": 3,
        "FromUserName": self.myAccount.UserName,
        "ToUserName": self.myAccount.UserName,
        "ClientMsgId": parseInt(_.now() / 1000)
    }

    self.session.post({
        url: url,
        body: params,
        json: true,
        jsonReviver: true
    }, _brc(function(err, data) {
        if (err) return cb(err);

        if (data.BaseResponse.Ret !== 0)
            return cb(new WXBotError('', format('[ERROR] Web WeChat status notify failed. ret = %s, message = %s', data.BaseResponse.Ret, data.BaseResponse.ErrMsg)));

        cb();
    }))

}

// 获取所有群里面用户信息
// Get information of accounts in all groups at once.
WXBot.prototype.batchGetGroupMembers = function(cb) {
    var self = this;


    https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxbatchgetcontact?type=ex&r=1459505234835&pass_ticket=xMta3zmk2uS1elackskZIe%252FbJpjfDc%252BcM3KHPUCc69hM7pAyuiEJC7Vt5QdSzMYa
    var url = format(self.baseURI + '/webwxbatchgetcontact?type=ex&r=%s&pass_ticket=%s', _.now(), self.passTicket);
    var params = {
        'BaseRequest': self.baseRequest,
        "Count": self.groupList.length,
        "List": _.chain(self.groupList)
            .map(function(group) {
                return {
                    'UserName': group.UserName,
                    'EncryChatRoomId': ''
                }
            })
            .value()
    };
    debug('params = %o', params);
    self.session.post({
        url: url,
        body: params,
        json: true,
        jsonReviver: true
    }, _brc(function(err, data) {
        if (err) return cb(err);
        debug('Batch get group members. %o', data);
        var groupMembers = {};
        for (var i = 0; i < data.ContactList.length; i++) {
            var group = data.ContactList[i];
            var gid = group.UserName;
            var members = group.MemberList;
            groupMembers[gid] = members;
        }
        debug('group_members = %o', groupMembers);
        cb(null, groupMembers);
    }))
}

WXBot.prototype.getContact = function(cb) {
    var self = this;

    var url = format(self.baseURI + '/webwxgetcontact?pass_ticket=%s&skey=%s&r=%s', self.passTicket, self.skey, _.now())
    self.session.post(url, _brc(function(err, data) {
        if (err) return cb(err);

        try {
            data = JSON.parse(data);
        } catch (e) {
            return cb(e);
        }

        debug('MemberList = %o', data.MemberList);

        self.memberList = data.MemberList;
        var specialUsers = ['newsapp', 'fmessage', 'filehelper', 'weibo', 'qqmail',
            'fmessage', 'tmessage', 'qmessage', 'qqsync', 'floatbottle',
            'lbsapp', 'shakeapp', 'medianote', 'qqfriend', 'readerapp',
            'blogapp', 'facebookapp', 'masssendapp', 'meishiapp',
            'feedsapp', 'voip', 'blogappweixin', 'weixin', 'brandsessionholder',
            'weixinreminder', 'wxid_novlwrv3lqwv11', 'gh_22b87fa7cb3c',
            'officialaccounts', 'notification_messages', 'wxid_novlwrv3lqwv11',
            'gh_22b87fa7cb3c', 'wxitil', 'userexperience_alarm', 'notification_messages'
        ];

        self.contactList = [];
        self.publicList = [];
        self.specialList = [];
        self.groupList = [];

        for (var i = 0; i < self.memberList.length; i++) {
            var contact = self.memberList[i];
            if ((contact.VerifyFlag & 8) !== 0) {
                // public account
                self.publicList.push(contact);
                self.accountInfo.normalMember[contact.UserName] = {
                    'type': 'public',
                    'info': contact
                };
            } else if (-1 !== _.indexOf(specialUsers, contact.UserName)) {
                // special account
                self.specialList.push(contact);
                self.accountInfo.normalMember[contact.UserName] = {
                    'type': 'special',
                    'info': contact
                };
            } else if (contact.UserName.indexOf('@@') !== -1) {
                // group
                self.groupList.push(contact);
                self.accountInfo.normalMember[contact.UserName] = {
                    'type': 'group',
                    'info': contact
                };
            } else if (contact.UserName === self.myAccount.UserName) {
                // self
                self.accountInfo.normalMember[contact.UserName] = {
                    'type': 'self',
                    'info': contact
                };
            } else {
                self.contactList.push(contact);
                self.accountInfo.normalMember[contact.UserName] = {
                    'type': 'contact',
                    'info': contact
                };
            }
        }

        debug('self.contactList = %o', self.contactList);
        debug('self.publicList = %o', self.publicList);
        debug('self.specialList = %o', self.specialList);
        debug('self.groupList = %o', self.groupList);

        self.batchGetGroupMembers(function(err, groupMembers) {
            if (err) return cb(err);
            self.groupMembers = groupMembers;

            for (var group in self.groupMembers) {
                for (var i = 0; i < self.groupMembers[group].length; i++) {
                    var member = self.groupMembers[group][i];
                    if (!self.accountInfo[member.UserName])
                        self.accountInfo.groupMember[member.UserName] = {
                            'type': 'group_member',
                            'info': member,
                            'group': group
                        };
                }
            }

            if (self.DEBUG) {
                try {
                    fs.writeFileSync(path.join(__dirname, 'contact_list.json'), JSON.stringify(self.contactList));
                    fs.writeFileSync(path.join(__dirname, 'special_list.json'), JSON.stringify(self.specialList));
                    fs.writeFileSync(path.join(__dirname, 'group_list.json'), JSON.stringify(self.groupList));
                    fs.writeFileSync(path.join(__dirname, 'public_list.json'), JSON.stringify(self.publicList));
                    fs.writeFileSync(path.join(__dirname, 'member_list.json'), JSON.stringify(self.memberList));
                    fs.writeFileSync(path.join(__dirname, 'group_members.json'), JSON.stringify(self.groupMembers));
                    fs.writeFileSync(path.join(__dirname, 'account_info.json'), JSON.stringify(self.accountInfo));
                } catch (e) {
                    console.log(e.stack)
                }
            }

            cb();
        })
    }));
}


WXBot.prototype.syncCheck = function(cb) {
    var self = this;
    var params = {
        'r': parseInt(_.now() / 1000),
        'sid': self.sid,
        'uin': self.uin,
        'skey': self.skey,
        'deviceid': self.deviceId,
        'synckey': self.syncKeyStr,
        '_': parseInt(_.now() / 1000)
    };

    var url = 'https://' + self.syncHost + '.weixin.qq.com/cgi-bin/mmwebwx-bin/synccheck?' + querystring.stringify(params);
    self.session.get(url, {
        timeout: 60000
    }, _brc(function(err, data) {
        if (err && err.code === 'ETIMEDOUT') {
            return cb(null, [-1, -1]);
        }

        if (err) return cb(err);

        if (self.DEBUG) console.log('[DEBUG] Web WeChat syncCheck response %s', data);
        var pm = data.match(/window.synccheck=\{retcode:"(\d+)",selector:"(\d+)"\}/);
        if (pm) {
            var retcode = pm[1];
            var selector = pm[2];
            cb(null, [retcode, selector]);
        } else {
            return cb(null, [-1, -1]);
        }
    }))
}


// 校验通道
WXBot.prototype.testSyncCheck = function(cb) {
    var self = this;

    async.eachSeries(['webpush', 'webpush2'], function(host, cb) {
        self.syncHost = host;
        self.syncCheck(function(err, data) {
            if (err) cb(); // ignore & next

            if (data[0] === '0') cb('break');
            else cb(); // next
        });
    }, function done(err) {
        if (err && err === 'break') {
            if (self.DEBUG) console.log('[DEBUG] Web WeChat sync host is %s .', self.syncHost);
            return cb();
        }

        cb(new WXBotError('', '[ERROR] Web WeChat syncCheck failed.'));
    });
}


WXBot.prototype.sync = function(cb) {
    var self = this;
    var url = self.baseURI + format('/webwxsync?sid=%s&skey=%s&lang=en_US&pass_ticket=%s', self.sid, self.skey, self.passTicket);

    var params = {
        'BaseRequest': self.baseRequest,
        'SyncKey': self.syncKey,
        'rr': ~(parseInt(_.now() / 1000))
    };

    self.session.post({
        url: url,
        body: params,
        json: true,
        jsonReviver: true,
        timeout: 60000
    }, _brc(function(err, data) {
        if (err && err.code === 'ETIMEDOUT') {
            return cb();
        }

        if (err) return cb(err);

        if (data.BaseResponse.Ret === 0) {
            self.syncKey = data.SyncKey;
            self.syncKeyStr = _.chain(self.syncKey.List)
                .map(function(keyVal) {
                    return keyVal.Key + '_' + keyVal.Val;
                })
                .join('|')
                .value();
        }

        cb(null, data);
    }));
}


/**
 * 获取通讯录用户信息
 * @param  {[type]} uid [description]
 * @return {[type]}     [description]
 */
WXBot.prototype.getContactInfo = function(uid) {
    var self = this;
    return _.get(self, ['accountInfo', 'normalMember', uid]);
}


/**
 * 获取用户昵称
 * @param  {[type]} uid [description]
 * @return {[type]}     {
 *                          remarkName: '',
 *                          nickName: '',
 *                          displayName: ''
 *                      }
 */
WXBot.prototype.getContactName = function(uid) {
    var self = this;
    var info = self.getContactInfo(uid);
    if (!info) return null;

    info = info.info;
    var name = {};
    if (info.RemarkName && !validator.isNull(info.RemarkName))
        name.remarkName = info.RemarkName;
    if (info.NickName && !validator.isNull(info.NickName))
        name.nickName = info.NickName;
    if (info.DisplayName && !validator.isNull(info.DisplayName))
        name.displayName = info.DisplayName;

    debug('Get contact name. uid=%s, name=%o', uid, name);
    return _.keys(name).length === 0 ? null : name;
}


// {
//     remarkName: '',
//     nickName: '',
//     displayName: ''
// }
// 获取更友好的昵称
WXBot.prototype.getContactPreferName = function(name) {
    var self = this;
    if (!name) return null;

    debug('Get contact prefer name. %o', name);
    if (name.remarkName) return name.remarkName;
    if (name.nickName) return name.nickName;
    if (name.displayName) return name.displayName;
    return null;
}


WXBot.prototype.isContact = function(uid) {
    var self = this;
    return -1 != _.findIndex(self.contactList, {
        'UserName': uid
    });
}


WXBot.prototype.isPublic = function(uid) {
    var self = this;
    return -1 != _.findIndex(self.publicList, {
        'UserName': uid
    });
}


WXBot.prototype.isSpecial = function() {
    var self = this;
    return -1 != _.findIndex(self.specialList, {
        'UserName': uid
    });
}


/**
 * 获取用户在群内昵称
 * @return {[type]} [description]
 */
WXBot.prototype.getGroupMemberInfo = function() {
    var self = this;
    var uid, gid;
    if (arguments.length === 0) {
        uid = arguments[0];
    } else {
        uid = arguments[0];
        gid = arguments[1];
    }

    var info;
    if (!gid)
        info = _.get(self, ['accountInfo', 'groupMember', uid]);
    else {
        var members = _.get(self, ['groupMembers', gid])
        if (members) {
            var member = _.find(members, {
                UserName: uid
            });

            if (member) {
                info = {
                    type: 'group_member',
                    info: member
                }
            }
        }
    }
    debug('Get group member info. uid=%s, gid=%s, %o', uid, gid, info);
    return info;
}


// """
// Get name of a member in a group.
// :param gid: group id
// :param uid: group member id
// :return: names like {"display_name": "test_user", "nickname": "test", "remark_name": "for_test" }
// """
// 获得用户群内昵称
WXBot.prototype.getGroupMemberName = function() {
    var self = this;

    var uid, gid;
    if (arguments.length === 0) {
        uid = arguments[0];
    } else {
        uid = arguments[0];
        gid = arguments[1];
    }

    var info = self.getGroupMemberInfo.apply(self, Array.prototype.slice.call(arguments));
    if (!info) return null;

    info = info.info;
    var name = {};
    if (info.RemarkName && !validator.isNull(info.RemarkName))
        name.remarkName = info.RemarkName;
    if (info.NickName && !validator.isNull(info.NickName))
        name.nickName = info.NickName;
    if (info.DisplayName && !validator.isNull(info.DisplayName))
        name.displayName = info.DisplayName;

    debug('Get group member name. uid=%s, gid=%s, name=%o', uid, gid, name);

    return _.keys(name).length === 0 ? null : name;
}


// 群内昵称
WXBot.prototype.getGroupMemberPreferName = function(name) {
    if (!name) return null;

    debug('Get group member prefer name. %o', name);
    if (name.remarkName) return name.remarkName;
    if (name.nickName) return name.nickName;
    if (name.displayName) return name.displayName;

    return null;
}


// """
// Get the relationship of a account and current user.
// :param wx_user_id:
// :return: The type of the account.
// """
// 获取用户是那个类型的。通讯录、公众号...
WXBot.prototype.getUserType = function(wxUserId) {
    var self = this;

    if (-1 !== _.findIndex(self.contactList, {
            'UserName': wxUserId
        })) {
        return 'contact';
    }

    if (-1 !== _.findIndex(self.publicList, {
            'UserName': wxUserId
        })) {
        return 'public';
    }

    if (-1 !== _.findIndex(self.specialList, {
            'UserName': wxUserId
        })) {
        return 'special';
    }

    if (-1 !== _.findIndex(self.groupList, {
            'UserName': wxUserId
        })) {
        return 'group';
    }

    if (-1 !== _.findIndex(self.groupMembers, {
            'UserName': wxUserId
        })) {
        return 'group_member';
    }

    return 'unkonwn';
}


// 获取群内@消息
WXBot.prototype.procAtInfo = function(msg) {
    var self = this;
    if (!msg) return {
        x: '',
        y: []
    };
    debug('Proc at info. msg=%s', msg);
    var segs = msg.split('\u2005');
    debug('segs=%o', segs);
    var strMsgAll = '';
    var strMsg = '';
    var infos = [];
    if (segs.length > 1) {
        var re = new RegExp('@.*\u2005');
        for (var i = 0; i < (segs.length - 1); i++) {
            segs[i] += '\u2005';
            var pm = segs[i].match(re);
            debug('pm=%s', pm);
            if (pm) {
                pm = pm[0];
                var name = pm.substring(1, pm.length - 1);
                var str = segs[i].replace(pm, '');
                strMsgAll += (str + '@' + name + ' ');
                strMsg += str;
                if (name)
                    infos.push({
                        type: 'str',
                        value: str
                    });
                infos.push({
                    type: 'at',
                    value: name
                })
            } else {
                infos.push({
                    type: 'at',
                    value: segs[i]
                });
                strMsgAll += segs[i];
                str_msg += segs[i];
            }
        }

        debug('for done.');
        strMsgAll += segs[segs.length - 1];
        strMsg += segs[segs.length - 1];
        infos.push({
            type: 'str',
            value: segs[segs.length - 1]
        })
    } else {
        infos.push({
            type: 'str',
            value: segs.slice(0, segs.length - 1)
        });
        strMsgAll = msg;
        strMsg = msg;
    }
    debug('At msg strMsgAll=%s, strMsg=%s, infos=%o', strMsgAll, strMsg, infos);
    return [strMsgAll.replace(/\u2005/gi, ''), strMsg.replace(/\u2005/gi, ''), infos];
}


WXBot.prototype.getIcon = function(uid) {
    var self = this;

    var url = self.baseURI + format('/webwxgeticon?username=%s&skey=%s', uid, self.skey);
    var fileName = 'img_icon_' + uid + '.jpg';
    // 异步下载
    self.session.get(url).pipe(fs.createWriteStream(path.join(__dirname, fileName)));
    return fileName;
}


WXBot.prototype.getHeadImg = function(uid) {
    var self = this;

    var url = self.baseURI + format('/webwxgetheadimg?username=%s&skey=%s', uid, self.skey);
    var fileName = 'img_head_' + uid + '.jpg';
    // 异步下载
    self.session.get(url).pipe(fs.createWriteStream(path.join(__dirname, fileName)));
    return fileName;
}


// 图片消息URL
WXBot.prototype.getMsgImgURL = function(msgId) {
    var self = this;
    return self.baseURI + format('/webwxgetmsgimg?MsgID=%s&skey=%s', msgId, self.skey)
}


// 下载图片消息
WXBot.prototype.getMagImg = function(msgId) {
    var self = this;
    var url = self.getMsgImgURL(msgId);
    var fileName = 'img_' + msgId + '.jpg';
    self.session.get(url).pipe(fs.createWriteStream(path.join(__dirname, fileName)));
    return fileName;
}


// 获取语音消息URL
WXBot.prototype.getVoiceURL = function(msgId) {
    var self = this;
    return self.baseURI + format('/webwxgetvoice?msgid=%s&skey=%s', msgId, self.skey);
}


// 下载语音消息
WXBot.prototype.getVoice = function(msgId) {
    var self = this;
    var url = self.getVoiceURL(msgId);
    var fileName = 'voice_' + msgId + '.mp3';
    self.session.get(url).pipe(fs.createWriteStream(path.join(__dirname, fileName)));
    return fileName;
}


WXBot.prototype.searchContent = function(key, content, fmat) {
    var self = this;
    if (self.DEBUG) console.log('[DEBUG] SearchContent key=%s, content=%s, fmat=%s', key, content, fmat);
    if (!fmat) fmat = 'attr';
    if (fmat === 'attr') {
        var re = new RegExp(key + '\s?=\s?"([^"<]+)"');
        var pm = content.match(re);
        if (pm)
            return pm[1];
    } else if (fmat === 'xml') {
        var re = new RegExp('<' + key + '>([^<]+)</' + key + '>');
        var pm = content.match(re);
        if (pm)
            return pm[1];
    }

    return 'unkonwn';
}


WXBot.prototype.getUserId = function(name) {
    var self = this;
    if (!name || validator.isNull(name)) return null;

    var contact = _.find(self.contactList, function(contact) {
        return name === content.RemarkName || name === contact.NickName || name === contact.DisplayName;
    });

    return !!contact ? contact.UserName : null;
}


WXBot.prototype.sendMsgByUid = function(word, dst, cb) {
    var self = this;
    if (self.DEBUG) console.log('[DEBUG]Web WeChat send msg. word = %s, dst = %s', word, dst);
    if (!dst) det = 'filehelper';
    var url = self.baseURI + format('/webwxsendmsg?pass_ticket=%s', self.passTicket);
    var msgId = '' + _.now() + randomstring.generate({
        length: 4,
        charset: 'numeric'
    });

    var params = {
        BaseRequest: self.baseRequest,
        Msg: {
            Type: 1,
            Content: word,
            FromUserName: self.myAccount.UserName,
            ToUserName: dst,
            LocalID: msgId,
            ClientMsgId: msgId
        }
    };

    self.session.post({
        url: url,
        body: params,
        json: true,
        jsonReviver: true
    }, _brc(function(err, data) {
        if (err) return cb(err);
        return cb(null, data.BaseResponse.Ret === 0);
    }));
}


// # 向好友发送消息，name 为好友的备注名或者好友微信号，
// # isfile为 False 时 word 为消息，isfile 为 True 时 word 为文件（文本文件）路径(此时向好友发送文件里的每一行)，
// # 此方法在有重名好友时会有问题，因此更推荐使用 send_msg_by_uid(word, dst)
WXBot.prototype.sendMsg = function(name, word, isFile, cb) {
    var self = this;
    isFile = !!isFile;
    var uid = self.getUserId(name);
    if (uid && !validator.isNull(uid)) {
        if (isFile) {
            // TODO
            cb(null, false);
        } else {
            self.sendMsgByUid(word, uid, cb);
        }
    } else {
        if (self.DEBUG)
            console.log('[ERROR] This user does not exist .');
        return cb(null, true);
    }
}


// """
// content_type_id:
//     0 -> Text
//     1 -> Location
//     3 -> Image
//     4 -> Voice
//     5 -> Recommend
//     6 -> Animation
//     7 -> Share
//     8 -> Video
//     9 -> VideoCall
//     10 -> Redraw
//     11 -> Empty
//     99 -> Unknown
// :param msg_type_id: The type of the received message.
// :param msg: The received message.
// :return: The extracted content of the message.
// """
// TODO 重构
WXBot.prototype.extractMsgContent = function(msgTypeId, msg, cb) {
    var self = this;

    if (self.DEBUG)
        fs.appendFileSync(path.join(__dirname, 'msg'), msgTypeId + '    ' + JSON.stringify(msg) + '\n\n');
    debug('Extract msg content. msgTypeId=%s, msg=%o', msgTypeId, msg);

    var msgType = msg.MsgType;
    var content = _.unescape(msg.Content);
    var msgId = msg.MsgId;

    var msgContent = {};
    if (msgTypeId === 0) {
        // init message
        return cb(null, {
            type: 11,
            data: ''
        });
    } else if (msgTypeId === 2) {
        // File Helper 文件传输助手
        return cb(null, {
            type: 0,
            data: _.replace(content, /<br\s*[\/]?>/gi, '\n')
        });
    } else if (msgTypeId === 3) {
        // Group
        content = content.split(/<br\s*[\/]?>/gi); // @uid:content
        var uid = content[0];
        debug('MsgTypeId=%s, uid=%s, content=%s', msgTypeId, uid, content);
        uid = uid.substring(0, uid.length - 1);
        var content = content.slice(1).join(' ');
        var name = self.getContactPreferName(self.getContactName(uid));
        if (!name)
            name = self.getGroupMemberPreferName(self.getGroupMemberName(uid, msg.FromUserName))
        if (!name)
            name = 'unkonwn';

        msgContent.user = {
            id: uid,
            name: name
        };
    } else {
        // Self, Contact, Special, Public, Unknown
        // pass
    }

    var msgPrefix = !!msgContent.user ? (msgContent.user.name + ':') : '';

    if (msgType === 1) {
        // 位置消息
        // TODO
        if (-1 !== content.indexOf('http://weixin.qq.com/cgi-bin/redirectforward?args=')) {
            self.session.get(content)
                .pipe(iconv.decodeStream('gbk'))
                .pipe(iconv.encodeStream('utf8'))
                .collect(function(err, data) {
                    if (err) return cb(err);
                    var pos = self.searchContent('title', data, 'xml');
                    msgContent.type = 1;
                    msgContent.data = pos;
                    msgContent.detail = data;

                    debug('    %s[Location] %s', msg_prefix, pos);
                    return cb(null, msgContent);
                });
        } else {
            msgContent.type = 0;
            if (msgTypeId === 3 || (msgTypeId === 1 && msg.ToUserName.substring(0, 2) === '@@')) {
                // Group text message
                var msgInfos = self.procAtInfo(content);
                var strMsgAll = msgInfos[0];
                var strMsg = msgInfos[1];
                var detail = msgInfos[2];
                msgContent.data = strMsgAll;
                msgContent.detail = detail;
                msgContent.desc = strMsg;
            } else {
                msgContent.data = content;
            }

            debug('----------------group msg----------------');
            debug(msgContent);
            debug('================group msg=================');
            debug('    %s[Text]%o', msgPrefix, msgContent.data);
            return cb(null, msgContent);
        }
    } else if (msgType === 3) {
        // 图片消息
        msgContent.type = 3;
        msgContent.data = self.getMsgImgURL(msgId);

        if (self.DEBUG) {
            var image = self.getMagImg(msgId);
            debug('    %s[Image]%s', msgPrefix, image);
        }

        return cb(null, msgContent);
    } else if (msgType === 34) {
        // 语音消息
        msgContent.type = 4;
        msgContent.data = self.getVoiceURL(msgId);

        if (self.DEBUG) {
            var voice = self.getVoice(msgId);
            debug('    %s[Voice]%s', msgPrefix, voice);
        }

        return cb(null, msgContent);
    } else if (msgType === 42) {
        // Recommend
        msgContent.type = 5;
        var info = msg.RecommendInfo;
        msgContent.data = {
            nickname: info.NickName,
            alias: info.Alias,
            province: info.Province,
            city: info.City,
            gender: ['unknown', 'male', 'female'][info.Sex]
        }

        if (self.DEBUG) {
            console.log('    %s[Recommend]', msgPrefix);
            console.log('    -----------------------------');
            console.log('    | NickName: %s', info.NickName);
            console.log('    | Alias: %s', info.Alias);
            console.log('    | Local: %s %s', (info.Province, info.City));
            console.log('    | Gender: %s', ['unknown', 'male', 'female'][info.Sex]);
            console.log('    -----------------------------');
        }

        return cb(null, msgContent);
    } else if (msgType === 47) {
        // Animation 动画
        msgContent.type = 6;
        msgContent.data = self.searchContent('cdnurl', content);

        debug('    %s[Animation] %o', (msgPrefix, msgContent.data));

        return cb(null, msgContent);
    } else if (msgType === 49) {
        // Share
        msgContent.type = 7;
        var appMsgType = '';
        if (msg.AppMsgType === 3) {
            appMsgType = 'music';
        } else if (msg.appMsgType === 5) {
            appMsgType = 'link';
        } else if (msg.appMsgType === 7) {
            appMsgType = 'weibo';
        } else {
            appMsgType = 'unkonwn';
        }
        msgContent.data = {
            type: appMsgType,
            title: msg.FileName,
            desc: self.searchContent('des', content, 'xml'),
            url: msg.Url,
            from: self.searchContent('appname', content, 'xml')
        }

        if (self.DEBUG) {
            console.log('    %s[Share] %s', msgPrefix, appMsgType);
            console.log('    --------------------------');
            console.log('    | title: %s', msg.FileName);
            console.log('    | desc: %s', self.searchContent('des', content, 'xml'));
            console.log('    | link: %s', msg.Url);
            console.log('    | from: %s', self.searchContent('appname', content, 'xml'));
            console.log('    --------------------------');
        }

        return cb(null, msgContent);
    } else if (msgType === 62) {
        msgContent.type = 8;
        msgContent.data = content;

        if (self.DEBUG)
            console.log('    %s[Video] Please check on mobiles', msgPrefix);

        return cb(null, msgContent);
    } else if (msgType === 53) {
        msgContent.type = 9;
        msgContent.data = content;

        if (self.DEBUG)
            console.log('    %s[Video Call]', msgPrefix);

        return cb(null, msgContent);
    } else if (msgType === 10002) {
        msgContent.type = 10;
        msgContent.data = content;

        if (self.DEBUG)
            console.log('    %s[Redraw]', msgPrefix);

        return cb(null, msgContent);
    } else if (msgType === 10000) {
        msgContent.type = 12;
        msgContent.data = msg.Contact;

        if (self.DEBUG)
            console.log('    [Unknown]');

        return cb(null, msgContent);
    } else {
        msgContent.type = 99;
        msgContent.data = content;

        if (self.DEBUG)
            console.log('    %s[Unknown]', msgPrefix);

        return cb(null, msgContent);
    }
}


// 处理消息
WXBot.prototype.handleMsgAll = function(message, cb) {
    cb();
}


// The inner function that processes raw WeChat messages.
// msg_type_id:
//     0 -> Init
//     1 -> Self
//     2 -> FileHelper
//     3 -> Group
//     4 -> Contact
//     5 -> Public
//     6 -> Special
//     99 -> Unknown
// :param r: The raw data of the messages.
// :return: None
WXBot.prototype.handleMsg = function(data, cb) {
    var self = this;

    async.each(data.AddMsgList, function(msg, cb) {
        var msgTypeId = 99;
        var user = {
            id: msg.FromUserName,
            name: 'unkonwn'
        };

        if (msg.MsgType === 51) {
            // init message
            msgTypeId = 0;
            user.name = 'system';
        } else if (msg.FromUserName === self.myAccount.UserName) {
            // self
            msgTypeId = 1;
            user.name = 'self';
        } else if (msg.ToUserName === 'filehelper') {
            // File Helper 文件传输助手
            msgTypeId = 2;
            user.name = 'file_helper';
        } else if (msg.FromUserName.substring(0, 2) === '@@') {
            // Group
            msgTypeId = 3;
            user.name = self.getContactPreferName(self.getContactName(user.id));
        } else if (self.isContact(msg.FromUserName)) {
            // Contact
            msgTypeId = 4;
            user.name = self.getContactPreferName(self.getContactName(user.id));
        } else if (self.isPublic(msg.FromUserName)) {
            // Public
            msgTypeId = 5;
            user.name = self.getContactPreferName(self.getContactName(user.id));
        } else if (self.isSpecial(msg.FromUserName)) {
            // Special
            msgTypeId = 6;
            user.name = self.getContactPreferName(self.getContactName(user.id));
        } else {
            msgTypeId = 99;
            user.name = 'unkonwn';
        }

        if (!user.name) user.name = 'unkonwn'; // 容错
        user.name = _.unescape(user.name);

        if (this.DEBUG && msgTypeId !== 0) console.log('[MSG] %s:', user.name)
        self.extractMsgContent(msgTypeId, msg, function(err, content) {
            if (err) return cb(); // ignore
            var message = {
                msgTypeId: msgTypeId,
                msgId: msg.MsgId,
                content: content,
                toUserId: msg.ToUserName,
                user: user
            };
            self.handleMsgAll(message, function(err) {
                cb();
            });
        });
    }, cb);
}


// 调度
WXBot.prototype.schedule = function() {

}


WXBot.prototype.procMsg = function(cb) {
    var self = this;
    Q.nfcall(self.testSyncCheck.bind(self))
        .then(function() {
            var deferred = Q.defer();
            var checkTime;

            function _procMsg() {
                checkTime = _.now();
                Q.nfcall(self.syncCheck.bind(self))
                    .then(function(data) {
                        var deferred = Q.defer();
                        var retcode = data[0];
                        var selector = data[1];

                        if (retcode === '1100') { // logout from mobile
                            // break
                            deferred.reject('break');
                        } else if (retcode === '1101') { // login web WeChat from other devide
                            // break
                            deferred.reject('break');
                        } else if (retcode === '0') {
                            if (selector === '2') {
                                // new message
                                self.sync(deferred.makeNodeResolver());

                                // r = self.sync()
                                // if r is not None:
                                //     self.handle_msg(r)
                            } else if (selector === '7') {
                                // Play WeChat on mobile
                                self.sync(deferred.makeNodeResolver());

                                // r = self.sync()
                                // if r is not None:
                                //     self.handle_msg(r)
                            } else if (selector === '0') {
                                // nothing
                                deferred.reject('break');
                            } else {
                                // pass
                                deferred.reject('break');
                            }
                        }

                        return deferred.promise;
                    })
                    .then(function(data) {
                        var deferred = Q.defer();

                        if (data)
                            self.handleMsg(data, deferred.makeNodeResolver());
                        else
                            deferred.reject('break');

                        return deferred.promise;
                    })
                    .catch(function() {
                        // ingore
                    })
                    .finally(function() {
                        setTimeout(function() {
                            _procMsg();
                        }, _.now() - checkTime < 800 ? (1000 - (_.now() - checkTime)) : 0);
                    });

                // self.schedule()
            }

            _procMsg();

            return deferred.promise;
        })
        .then(function() {
            cb();
        })
        .catch(cb);
}


WXBot.prototype.run = function() {
    var self = this;
    Q.nfcall(self.getUUID.bind(self))
        .then(function() {
            console.log('[INFO] Please use WeChat to scan the QR code.');
            return Q.nfcall(self.genQRCode.bind(self));
        })
        .then(function() {
            return Q.nfcall(self.wait4login.bind(self));
        })
        .then(function(code) {
            if (self.DEBUG) console.log('[DEBUG] Wait4login code=%s', code);
            var deferred = Q.defer();
            if (code !== SUCCESS) {
                console.log('[ERROR] Web WeChat login failed. failed code=%s', code);
                deferred.reject('break');
            } else {
                self.login(deferred.makeNodeResolver());
            }
            return deferred.promise;
        })
        .then(function() {
            return Q.nfcall(self.init.bind(self));
        })
        .then(function() {
            return Q.nfcall(self.statusNotify.bind(self));
        })
        .then(function() {
            return Q.nfcall(self.getContact.bind(self));
        })
        .then(function() {
            console.log('[INFO] Get %d contacts', self.contactList.length)
            console.log('[INFO] Start to process messages .')
        })
        .then(function() {
            return Q.nfcall(self.procMsg.bind(self));
        })
        .catch(function(err) {
            console.log(err);
        })
}


// var wxbot = new WXBot({
//     DEBUG: true
// });
// wxbot.run();
module.exports = WXBot;