const Fs = require('fs');
const Url = require('url');
const Qs = require('querystring');
const CONN = {};
const CACHE = {};
const COMPARE = { '<': '<', '>': '>', '>=': '>=', '=>': '>=', '=<': '<=', '<=': '<=', '==': '=', '===': '=', '!=': '!=', '<>': '!=', '=': '=' };
const MODIFY = { insert: 1, update: 1, modify: 1 };

function promise(fn) {
	var self = this;
	return new Promise(function(resolve, reject) {
		self.callback(function(err, result) {
			if (err)
				reject(err);
			else
				resolve(fn == null ? result : fn(result));
		});
	});
}

var logger;

function DBMS(ebuilder) {
	var self = this;
	self.$commands = [];
	self.$output = {};
	self.$outputall = {};
	self.$eb = global.ErrorBuilder != null;
	self.$errors = ebuilder || (global.ErrorBuilder ? new global.ErrorBuilder() : []);

	// self.$log;
	// self.$lastoutput;

	self.$next = function(err) {
		err & self.$errors.push(err);
		self.next();
	};
}

const DP = DBMS.prototype;

DP.blob = function(table) {

	if (!table)
		table = 'default';

	var cache = CACHE[table];
	if (!cache) {
		var tmp = table.split('/');
		cache = { db: tmp.length > 1 ? tmp[0] : 'default', table: tmp.length > 1 ? tmp[1] : tmp[0] };
		CACHE[table] = cache;
	}

	var conn = CONN[cache.db];
	var driver = require('./' + conn.db);

	return {
		write: function(stream, filename, callback) {
			driver.blob_write(conn, stream, filename, callback, cache);
		},
		read: function(id, callback) {
			driver.blob_read(conn, id, callback, cache);
		},
		remove: function(id, callback) {
			driver.blob_remove(conn, id, callback, cache);
		}
	};
};

DP.output = function(val) {
	this.$output = val;
	return this;
};

function debug(val) {
	console.log('DBMS --->', val);
}

DP.debug = function() {
	this.$debug = debug;
	return this;
};

DP.callback = function(fn) {
	var self = this;
	self.$callback = fn;
	return self;
};

DP.data = function(fn) {
	var self = this;
	self.$callbackok = fn;
	return self;
};

DP.fail = function(fn) {
	var self = this;
	self.$callbackno = fn;
	return self;
};

DP.get = function(path) {
	var self = this;
	path = path.split('.');
	return function() {
		var data = self.$outputall;
		var p, tmp;
		for (var i = 0; i < path.length - 1; i++) {
			p = path[i];
			if (data && data[p] != null) {
				data = data[p];
			} else {
				data = null;
				break;
			}
		}
		p = path[path.length - 1];
		if (data instanceof Array) {
			tmp = [];
			for (var i = 0; i < data.length; i++) {
				var val = data[i][p];
				if (val != null)
					tmp.push(val);
			}
			return tmp;
		} else
			return data ? data[p] : null;
	};
};

DP.next = function() {

	var self = this;
	var cmd = self.$commands.shift();

	logger && loggerend(self);

	if (cmd) {

		if (cmd.builder && cmd.builder.$joinmeta) {
			if (!cmd.builder.$joinmeta.can) {
				self.$commands.push(cmd);
				setImmediate(self.$next);
				return;
			}
		}

		if (cmd.type === 'task') {
			cmd.value.call(self, self.$outputall, self.$lastoutput);
			setImmediate(self.$next);
		} else if (cmd.type === 'validate') {
			var type = typeof(cmd.value);
			var stop = false;
			switch (type) {
				case 'function':
					var val = cmd.value(self.$lastoutput, self.$output);
					if (typeof(val) === 'string') {
						stop = true;
						self.$errors.push(val);
					}
					break;
				case 'string':
					if (self.$lastoutput instanceof Array) {
						if (cmd.reverse) {
							if (self.$lastoutput.length) {
								self.$errors.push(cmd.value);
								stop = true;
							}
						} else {
							if (!self.$lastoutput.length) {
								self.$errors.push(cmd.value);
								stop = true;
							}
						}
					} else {
						if (cmd.reverse) {
							if (self.$lastoutput) {
								self.$errors.push(cmd.value);
								stop = true;
							}
						} else {
							if (!self.$lastoutput) {
								self.$errors.push(cmd.value);
								stop = true;
							}
						}
					}
					break;
			}
			if (stop) {
				self.$commands = null;
				self.$callback && self.$callback(self.$errors, null);
			} else
				setImmediate(self.$next);
		} else {
			if (MODIFY[cmd.type] && cmd.value && typeof(cmd.value.$clean) === 'function')
				cmd.value = cmd.value.$clean();
			var conn = CONN[cmd.conn || cmd.builder.options.db];
			logger && loggerbeg(self, cmd);
			require('./' + conn.db).run(conn, self, cmd);
		}
	} else {
		var err = self.$eb ? self.$errors.items.length > 0 ? self.$errors : null : self.$errors.length > 0 ? self.$errors : null;
		self.$callback && self.$callback(err, self.$output);
		if (err)
			self.$callbackno && self.$callbackno(err);
		else
			self.$callbackok && self.$callbackok(self.$output);
	}
	return self;
};

function loggerbeg(self, cmd) {
	cmd.ts = new Date();
	self.$logger = cmd;
}

function loggerend(self) {
	if (self.$logger) {
		var ln = (self.$logger.builder.options.db === 'default' ? '' : (self.$logger.builder.options.db + '/')) + (self.$logger.builder.options.table || '');
		NOW = new Date();
		logger(NOW.format('yyyy-MM-dd HH:mm:ss'), 'DBMS logger: ' + (ln ? (ln + '.') : '') + self.$logger.type + '()', self.$logger.builder.$count + 'x', ((NOW - self.$logger.ts) / 1000) + 's');
		self.$logger = null;
	}
}

DP.make = function(fn) {
	var self = this;
	fn.call(self, self);
	return self;
};

DP.find = function(table) {
	var self = this;
	var builder = new QueryBuilder(self, 'find');
	builder.table(table);
	self.$commands.push({ type: 'find', builder: builder });
	if (!self.$joinmeta) {
		self.$op && clearImmediate(self.$op);
		self.$op = setImmediate(self.$next);
	}
	return builder;
};

DP.task = function(fn) {
	this.$commands.push({ type: 'task', value: fn });
	return this;
};

DP.list = DP.listing = function(table) {
	var self = this;
	var builder = new QueryBuilder(self, 'list');
	builder.table(table);
	builder.take(100);
	self.$commands.push({ type: 'list', builder: builder });
	self.$op && clearImmediate(self.$op);
	self.$op = setImmediate(self.$next);
	return builder;
};

DP.read = DP.one = function(table) {
	var self = this;
	var builder = new QueryBuilder(self, 'read');
	builder.table(table);
	builder.first();
	self.$commands.push({ type: 'read', builder: builder });
	self.$op && clearImmediate(self.$op);
	self.$op = setImmediate(self.$next);
	return builder;
};

DP.scalar = function(table, type, name) {

	// type: avg
	// type: count
	// type: group
	// type: max
	// type: min
	// type: sum

	var self = this;
	var builder = new QueryBuilder(self, 'scalar');
	builder.table(table);
	self.$commands.push({ type: 'scalar', builder: builder, scalar: type, name: name });
	self.$op && clearImmediate(self.$op);
	self.$op = setImmediate(self.$next);
	return builder;
};

DP.count = function(table) {
	return this.scalar(table, 'count');
};

DP.max = function(table, prop) {
	return this.scalar(table, 'max', prop);
};

DP.min = function(table, prop) {
	return this.scalar(table, 'min', prop);
};

DP.avg = function(table, prop) {
	return this.scalar(table, 'avg', prop);
};

DP.sum = function(table, prop) {
	return this.scalar(table, 'sum', prop);
};

DP.group = function(table, prop) {
	return this.scalar(table, 'group', prop);
};

DP.begin = DP.transaction = function(conn) {
	var self = this;
	self.$commands.push({ type: 'transaction', db: self, conn: conn || 'default' });
	return self;
};

DP.commit = function(conn) {
	var self = this;
	self.$commands.push({ type: 'commit', db: self, conn: conn || 'default' });
	return self;
};

DP.rollback = DP.abort = function(conn) {
	var self = this;
	self.$commands.push({ type: 'rollback', db: self, conn: conn || 'default' });
	return self;
};

DP.save = function(table, isUpdate, obj, fn) {

	if (obj == null || typeof(obj) === 'function') {
		fn = obj;
		obj = isUpdate;
		isUpdate = !!obj.id;
	}

	var builder = isUpdate ? this.modify(table, obj) : this.insert(table, obj);
	fn && fn.call(builder, builder, isUpdate, builder.value);
	return builder;
};

DP.insert = function(table, value, unique) {
	var self = this;
	var builder = new QueryBuilder(self, 'insert');
	builder.table(table);
	builder.value = value || {};
	unique && builder.first();

	// Total.js schemas
	if (builder.value.$clean)
		builder.value = builder.value.$clean();

	builder.$commandindex = self.$commands.push({ type: 'insert', builder: builder, unique: unique }) - 1;
	self.$op && clearImmediate(self.$op);
	self.$op = setImmediate(self.$next);
	return builder;
};

DP.update = function(table, value, insert) {
	var self = this;
	var builder = new QueryBuilder(self, 'update');
	builder.table(table);
	builder.value = value || {};

	// Total.js schemas
	if (builder.value.$clean)
		builder.value = builder.value.$clean();

	builder.$commandindex = self.$commands.push({ type: 'update', builder: builder, insert: insert }) - 1;
	self.$op && clearImmediate(self.$op);
	self.$op = setImmediate(self.$next);
	return builder;
};

DP.modify = function(table, value, insert) {
	var self = this;
	var builder = new QueryBuilder(self, 'modify');
	builder.table(table);
	builder.value = value || {};

	// Total.js schemas
	if (builder.value.$clean)
		builder.value = builder.value.$clean();

	builder.$commandindex = self.$commands.push({ type: 'modify', builder: builder, insert: insert }) - 1;
	self.$op && clearImmediate(self.$op);
	self.$op = setImmediate(self.$next);
	return builder;
};

DP.query = function(query, value) {
	var self = this;
	var builder = new QueryBuilder(self, 'query');
	self.$commands.push({ type: 'query', builder: builder, query: query, value: value });
	self.$op && clearImmediate(self.$op);
	self.$op = setImmediate(self.$next);
	return builder;
};

DP.remove = function(table) {
	var self = this;
	var builder = new QueryBuilder(self, 'remove');
	builder.table(table);
	self.$commands.push({ type: 'remove', builder: builder });
	self.$op && clearImmediate(self.$op);
	self.$op = setImmediate(self.$next);
	return builder;
};

DP.must = DP.validate = function(err, reverse) {
	var self = this;
	self.$commands.push({ type: 'validate', value: err || 'unhandled exception', reverse: reverse });
	return self;
};

function QueryBuilder(db, type) {
	var self = this;
	self.db = db;
	self.$commands = [];
	self.options = { db: 'default', type: type, take: 0, skip: 0, first: false, fields: null, dynamic: false };
}

const QB = QueryBuilder.prototype;
const NOOP = function(){};

QB.promise = promise;

QB.get = function(path) {
	return this.db.get(path);
};

QB.log = function(msg, user) {
	var self = this;
	if (msg) {
		NOW = new Date();
		self.$log = (self.$log ? self.$log : '') + NOW.format('yyyy-MM-dd HH:mm:ss') + ' | '  + self.options.table.padRight(25) + ': ' + (user ? '[' + user.padRight(20) + '] ' : '') + msg + '\n';
	} else if (self.$log) {
		Fs.appendFile(F.path.logs('dbms.log'), self.$log, NOOP);
		self.$log = null;
	}
	return self;
};

QB.table = function(table) {
	var self = this;
	var cache = CACHE[table];
	if (!cache) {
		var tmp = table.split('/');
		cache = { db: tmp.length > 1 ? tmp[0] : 'default', table: tmp.length > 1 ? tmp[1] : tmp[0] };
		CACHE[table] = cache;
	}
	self.options.db = cache.db;
	self.options.table = cache.table;
	return self;
};

QB.$callback = function(err, value, count) {

	var self = this;
	var opt = self.options;

	self.$log && self.log();

	if (logger)
		self.$count = value instanceof Array ? value.length : value != null ? 1 : 0;

	if (opt.type === 'list') {
		value = { items: value, count: count };
		value.page = (opt.skip / opt.take) + 1;
		value.limit = opt.take;
		value.pages = Math.ceil(count / value.limit);
	}

	opt.callback && opt.callback(err, value, count);

	if (err) {

		self.db.$errors.push(err);
		self.db.$lastoutput = null;
		self.db.$outputall[opt.table] = null;
		opt.callbackno && opt.callbackno(err);

	} else {

		self.db.$outputall[opt.table] = self.db.$lastoutput = value;
		if (opt.assign)
			self.db.$outputall[opt.assign] = self.db.$output[opt.assign] = value;
		else
			self.db.$output = value;

		var ok = true;
		if (opt.validate) {
			if (value instanceof Array) {
				if (!value.length) {
					self.db.$errors.push(opt.validate);
					ok = false;
				}
			} else if (!value) {
				self.$errors.push(opt.validate);
				ok = false;
			}
		}

		if (ok)
			opt.callbackok && opt.callbackok(value, count);
		else
			opt.callbackno && opt.callbackno(opt.validate);
	}

	setImmediate(self.db.$next);
};

QB.make = function(fn) {
	var self = this;
	fn.call(self, self);
	return self.db;
};

QB.inc = function(prop, value) {

	var self = this;

	if (self.$commandindex == null)
		throw new Error('This QueryBuilder.inc() is supported for INSERT/UPDATE/MODIFY operations.');

	var cmd = self.db.$commands[self.$commandindex];

	if (value > 0)
		prop = '+' + prop;
	else {
		prop = '-' + prop;
		value = value * -1;
	}

	if (cmd.value[prop])
		cmd.value += value;
	else
		cmd.value[prop] = value;

	return self;
};

QB.set = QB.upd = function(prop, value) {

	var self = this;

	if (value === undefined) {
		self.options.assign = prop == null ? '' : prop;
		return self;
	}

	if (self.$commandindex == null)
		throw new Error('This QueryBuilder.inc() is supported for INSERT/UPDATE/MODIFY operations.');

	self.model[prop] = value;
	return self;
};

// Is same as `set()` without `value`
QB.assign = function(prop) {
	var self = this;
	self.options.assign = prop == null ? '' : prop;
	return self;
};

QB.eq = function() {
	var model = arguments[arguments.length - 1];
	for (var i = 0; i < arguments.length - 1; i++)
		this.where(arguments[i], model[arguments[i]]);
	return this;
};

QB.where = function(name, compare, value) {

	if (value === undefined) {
		value = compare;
		compare = '=';
	} else {
		compare = COMPARE[compare];
		if (compare == null)
			throw new Error('DBMS: comparer "' + compare + '" is not supported for QueryBuilder.');
	}

	var self = this;
	self.$commands.push({ type: 'where', name: name, value: value, compare: compare });
	return self;
};

QB.in = function(name, value) {
	var self = this;
	self.$commands.push({ type: 'in', name: name, value: value });
	return self;
};

QB.notin = function(name, value) {
	var self = this;
	self.$commands.push({ type: 'notin', name: name, value: value });
	return self;
};

QB.between = function(name, a, b) {
	var self = this;
	self.$commands.push({ type: 'between', name: name, a: a, b: b });
	return self;
};

QB.search = function(name, value, compare) {
	var self = this;
	self.$commands.push({ type: 'search', name: name, value: value, compare: compare == null ? '*' : compare });
	return self;
};

QB.fulltext = function(name, value, weight) {
	var self = this;
	self.$commands.push({ type: 'fulltext', name: name, value: value, weight: weight });
	return self;
};

QB.regexp = function(name, value) {
	var self = this;
	self.$commands.push({ type: 'regexp', name: name, value: value });
	return self;
};

QB.contains = function(name) {
	var self = this;
	self.$commands.push({ type: 'contains', name: name });
	return self;
};

QB.empty = function(name) {
	var self = this;
	self.$commands.push({ type: 'empty', name: name });
	return self;
};

QB.first = function() {
	var self = this;
	self.options.first = true;
	self.take(1);
	return self;
};

QB.sort = function(name, desc) {
	var self = this;
	self.$commands.push({ type: 'sort', name: name, desc: desc == true || desc === 'desc' });
	return self;
};

QB.take = function(value) {
	var self = this;
	self.options.take = value;
	return self;
};

QB.skip = function(value) {
	var self = this;
	self.options.skip = value;
	return self;
};

QB.limit = function(value) {
	var self = this;
	self.options.limit = value;
	return self;
};

QB.page = function(page, limit) {
	var self = this;
	if (limit)
		self.options.take = limit;
	self.options.take = page * self.options.take;
	return self;
};

QB.paginate = function(page, limit, maxlimit) {

	var self = this;
	var limit2 = +(limit || 0);
	var page2 = (+(page || 0)) - 1;

	if (page2 < 0)
		page2 = 0;

	if (maxlimit && limit2 > maxlimit)
		limit2 = maxlimit;

	if (!limit2)
		limit2 = maxlimit;

	self.options.skip = page2 * limit2;
	self.options.take = limit2;
	return self;
};

QB.callback = function(callback) {
	var self = this;

	// Because of JOINS
	if (self.options.callback && self.$joinmeta && self.$joinmeta.owner && !self.$joinmeta.callback) {
		self.$joinmeta.callback = true;
		self.$joinmeta.owner.options.callback = self.options.callback;
	}

	self.options.callback = callback;
	return self;
};

QB.data = function(fn) {
	var self = this;

	// Because of JOINS
	if (self.$joinmeta && self.$joinmeta.owner)
		self.$joinmeta.owner.options.callbackok = fn;
	else
		self.options.callbackok = fn;

	return self;
};

QB.fail = function(fn) {
	var self = this;

	// Because of JOINS
	if (self.$joinmeta && self.$joinmeta.owner)
		self.$joinmeta.owner.options.callbackno = fn;
	else
		self.options.callbackno = fn;

	return self;
};

QB.on = function(a, b) {
	var self = this;
	self.$joinmeta.a = a;
	self.$joinmeta.b = b;
	return self;
};

QB.join = function(field, table) {

	if (table == null)
		table = field;

	var self = this;
	var builder = new QueryBuilder(self.db, 'find');

	builder.table(table);
	builder.$joinmeta = { unique: new Set(), field: field, a: '', b: '', owner: self.$joinmeta ? self.$joinmeta.owner : self };

	if (self.$joins)
		self.$joins.push(builder);
	else
		self.$joins = [builder];

	self.db.$commands.push({ type: 'find', builder: builder });
	return builder;
};

QB.must = QB.validate = function(err) {
	var self = this;
	self.options.validate = err || 'unhandled exception';
	return self;
};

QB.insert = function(callback) {
	var self = this;
	self.options.insert = callback;
	return self;
};

QB.query = function(value) {
	var self = this;
	self.$commands.push({ type: 'query', value: value });
	return self;
};

QB.or = function(fn) {
	var self = this;
	self.$commands.push({ type: 'or' });
	fn.call(self, self);
	self.$commands.push({ type: 'end' });
	return self;
};

QB.fields = function() {
	var self = this;
	if (!self.options.fields)
		self.options.fields = [];
	for (var i = 0; i < arguments.length; i++)
		self.options.fields.push(arguments[i]);
	return self;
};

QB.year = function(name, compare, value) {

	if (value === undefined) {
		value = compare;
		compare = '=';
	} else {
		compare = COMPARE[compare];
		if (compare == null)
			throw new Error('DBMS: comparer "' + compare + '" is not supported for QueryBuilder.');
	}

	var self = this;
	self.$commands.push({ type: 'year', name: name, value: value, compare: compare });
	return self;
};

QB.month = function(name, compare, value) {

	if (value === undefined) {
		value = compare;
		compare = '=';
	} else {
		compare = COMPARE[compare];
		if (compare == null)
			throw new Error('DBMS: comparer "' + compare + '" is not supported for QueryBuilder.');
	}

	var self = this;
	self.$commands.push({ type: 'month', name: name, value: value, compare: compare });
	return self;
};

QB.day = function(name, compare, value) {

	if (value === undefined) {
		value = compare;
		compare = '=';
	} else {
		compare = COMPARE[compare];
		if (compare == null)
			throw new Error('DBMS: comparer "' + compare + '" is not supported for QueryBuilder.');
	}

	var self = this;
	self.$commands.push({ type: 'day', name: name, value: value, compare: compare });
	return self;
};

QB.hour = function(name, compare, value) {

	if (value === undefined) {
		value = compare;
		compare = '=';
	} else {
		compare = COMPARE[compare];
		if (compare == null)
			throw new Error('DBMS: comparer "' + compare + '" is not supported for QueryBuilder.');
	}

	var self = this;
	self.$commands.push({ type: 'hour', name: name, value: value, compare: compare });
	return self;
};

QB.minute = function(name, compare, value) {

	if (value === undefined) {
		value = compare;
		compare = '=';
	} else {
		compare = COMPARE[compare];
		if (compare == null)
			throw new Error('DBMS: comparer "' + compare + '" is not supported for QueryBuilder.');
	}

	var self = this;
	self.$commands.push({ type: 'minute', name: name, value: value, compare: compare });
	return self;
};

QB.query = function(value) {
	var self = this;
	self.$commands.push({ type: 'code', value: value });
	return self;
};

exports.QueryBuilder = QueryBuilder;
exports.DBMS = DBMS;
exports.make = function(fn) {
	var self = new DBMS();
	fn.call(self, self);
	return self;
};

exports.init = function(name, connection) {

	if (connection == null || typeof(connection) === 'function') {
		connection = name;
		name = 'default';
	}

	// Total.js
	if (connection === 'nosql' || connection === 'table') {
		CONN[name] = { id: name, db: 'total', type: connection };
		return exports;
	}

	var opt = Url.parse(connection);
	var q = Qs.parse(opt.query);
	var tmp = {};
	var arr;

	var pooling = q.pooling ? q.pooling !== '0' && q.pooling !== 'false' && q.pooling !== 'off' : true;
	var native = q.native === '1' || q.native === 'true' || q.native === 'on';

	switch (opt.protocol) {
		case 'postgresql:':
		case 'postgres:':
		case 'postgre:':
		case 'pg:':
			if (opt.auth) {
				arr = opt.auth.split(':');
				tmp.user = arr[0] || '';
				tmp.password = arr[1] || '';
			}
			tmp.host = opt.hostname;
			tmp.port = opt.port;
			tmp.database = opt.pathname.split('/')[1];
			tmp.ssl = q.ssl === '1' || q.ssl === 'true' || q.ssl === 'on';
			tmp.max = +(q.max || '4');
			tmp.min = +(q.min || '2');
			tmp.idleTimeoutMillis = +(q.timeout || '1000');
			tmp.native = native;
			tmp.pooling = pooling;
			CONN[name] = { id: name, db: 'pg', options: tmp };
			break;
		case 'mongodb:':
		case 'mongo:':
			CONN[name] = { id: name, db: 'mongo', options: connection, database: q.database };
			break;


	}

	return exports;
};

global.DBMS = function(err) {
	if (typeof(err) === 'function') {
		var db = new exports.DBMS();
		err.call(db, db);
	} else
		return new exports.DBMS(err);
};

global.DBMS.logger = function(fn) {
	if (fn === undefined)
		logger = console.log;
	else
		logger = fn;
};

// Total.js framework
if (global.F) {
	global.F.database = function(err) {
		if (typeof(err) === 'function') {
			var db = new exports.DBMS();
			err.call(db, db);
		} else
			return new exports.DBMS(err);
	};
}

// Converting values
var convert = function(value, type) {

	if (type === undefined || type === String)
		return value;

	if (type === Number)
		return value.trim().parseFloat();

	if (type === Date) {
		value = value.trim();
		if (value.indexOf(' ') !== -1)
			return NOW.add('-' + value);
		if (value.length < 8) {
			var tmp;
			var index = value.indexOf('-');
			if (index !== -1) {
				tmp = value.split('-');
				value = NOW.getFullYear() + '-' + (tmp[0].length > 1 ? '' : '0') + tmp[0] + '-' + (tmp[1].length > 1 ? '' : '0') + tmp[1];
			} else {
				index = value.indexOf('.');
				if (index !== -1) {
					tmp = value.split('.');
					value = NOW.getFullYear() + '-' + (tmp[1].length > 1 ? '' : '0') + tmp[0] + '-' + (tmp[0].length > 1 ? '' : '0') + tmp[1];
				} else {
					index = value.indexOf(':');
					if (index !== -1) {
						// hours
					} else if (value.length <= 4) {
						value = +value;
						return value || 0;
					}
				}
			}
		}

		return value.trim().parseDate();
	}

	if (type === Boolean)
		return value.trim().parseBoolean();

	return value;
};

// Grid filtering
QB.gridfilter = function(name, obj, type, key) {

	var builder = this;
	var value = obj[name];
	var arr, val;

	if (!key)
		key = name;

	// Between
	var index = value.indexOf(' - ');
	if (index !== -1) {

		arr = value.split(' - ');

		for (var i = 0, length = arr.length; i < length; i++) {
			var item = arr[i].trim();
			arr[i] = convert(item, type);
		}

		if (type === Date) {
			if (typeof(arr[0]) === 'number') {
				arr[0] = new Date(arr[0], 1, 1, 0, 0, 0);
				arr[1] = new Date(arr[1], 11, 31, 23, 59, 59);
			} else
				arr[1] = arr[1].extend('23:59:59');
		}

		return builder.between(key, arr[0], arr[1]);
	}

	// Multiple values
	index = value.indexOf(',');
	if (index !== -1) {

		var arr = value.split(',');

		if (type === undefined || type === String) {
			builder.or();
			for (var i = 0, length = arr.length; i < length; i++) {
				var item = arr[i].trim();
				builder.search(key, item);
			}
			return builder.end();
		}

		for (var i = 0, length = arr.length; i < length; i++)
			arr[i] = convert(arr[i], type);

		return builder.in(key, arr);
	}

	if (type === undefined || type === String)
		return builder.search(key, value);

	if (type === Date) {

		if (value === 'yesterday')
			val = NOW.add('-1 day');
		else if (value === 'today')
			val = NOW;
		else
			val = convert(value, type);

		if (typeof(val) === 'number') {
			if (val > 1000)
				return builder.year(key, val);
			else
				return builder.month(key, val);
		}

		if (!(val instanceof Date) || !val.getTime())
			val = NOW;

		return builder.between(key, val.extend('00:00:00'), val.extend('23:59:59'));
	}

	return builder.where(key, convert(value, type));
};

// Grid sorting
QB.gridsort = function(sort) {
	var builder = this;
	var index = sort.lastIndexOf('_');
	if (index === -1)
		index = sort.lastIndexOf(' ');
	builder.sort(sort.substring(0, index), sort.substring(index + 1) === 'desc');
	return builder;
};

Array.prototype.dbmswait = function(onItem, callback, thread, tmp) {

	var self = this;
	var init = false;

	// INIT
	if (!tmp) {

		if (typeof(callback) !== 'function') {
			thread = callback;
			callback = null;
		}

		tmp = {};
		tmp.pending = 0;
		tmp.index = 0;
		tmp.thread = thread;

		// thread === Boolean then array has to be removed item by item

		init = true;
	}

	var item = thread === true ? self.shift() : self[tmp.index++];
	if (item === undefined) {
		if (!tmp.pending) {
			callback && callback();
			tmp.cancel = true;
		}
		return self;
	}

	tmp.pending++;
	onItem.call(self, item, () => setImmediate(next_wait, self, onItem, callback, thread, tmp), tmp.index);

	if (!init || tmp.thread === 1)
		return self;

	for (var i = 1; i < tmp.thread; i++)
		self.dbmswait(onItem, callback, 1, tmp);

	return self;
};

function next_wait(self, onItem, callback, thread, tmp) {
	tmp.pending--;
	self.dbmswait(onItem, callback, thread, tmp);
}

DP._findItem = function(items, field, value) {
	if (value instanceof Array) {
		for (var j = 0; j < value.length; j++) {
			if (items[field] === value[j])
				return items;
		}
	} else if (items[field] === value)
		return items;
};

DP._findItems = function(items, field, value) {
	var arr = [];
	for (var i = 0, length = items.length; i < length; i++) {
		if (value instanceof Array) {
			for (var j = 0; j < value.length; j++) {
				if (items[i][field] === value[j]) {
					arr.push(items[i]);
					break;
				}
			}
		} else if (items[i][field] === value)
			arr.push(items[i]);
	}
	return arr;
};

DP._joins = function(response, builder) {

	// Prepares unique values for joining
	if (response instanceof Array && response.length) {
		for (var i = 0; i < response.length; i++) {
			var item = response[i];
			for (var j = 0; j < builder.$joins.length; j++) {
				var join = builder.$joins[j];
				var meta = join.$joinmeta;
				var val = item[meta.b];
				if (val !== undefined) {
					if (val instanceof Array) {
						for (var k = 0; k < val.length; k++)
							meta.unique.add(val[k]);
					} else
						meta.unique.add(val);
				}
			}
		}
	} else if (response) {
		for (var j = 0; j < builder.$joins.length; j++) {
			var join = builder.$joins[j];
			var meta = join.$joinmeta;
			var val = response[meta.b];
			if (val !== undefined)
				meta.unique.add(val);
		}
	}

	builder.$joins.dbmswait(function(join, next) {
		var meta = join.$joinmeta;
		meta.can = true;
		join.in(meta.a, Array.from(meta.unique));
		join.callback(function(err, data) {

			if (err) {
				builder.$callback(err, response);
				builder.$joins.length = null;
				return;
			}

			if (response instanceof Array) {
				for (var i = 0; i < response.length; i++) {
					var row = response[i];
					row[meta.field] = join.options.first ? join.db._findItem(data, meta.a, row[meta.b]) : join.db._findItems(data, meta.a, row[meta.b]);
				}
			} else if (response)
				response[meta.field] = join.options.first ? join.db._findItem(data, meta.a, response[meta.b]) : join.db._findItems(data, meta.a, response[meta.b]);

			next();
		});
	}, () => builder.$callback(null, response), 3);
};