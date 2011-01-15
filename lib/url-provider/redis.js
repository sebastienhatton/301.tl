redis = require('redis')
conv = require('base-converter')

client = null
config = {}

key_long2short = config.key_long2short_callback || function(url) {
	return "url:" + url + ":short"
}

key_short2long = config.key_short2long_callback || function(key) {
	return "url:" + key + ":long"
}

Provider = {

	onError: function(err) {
		if (err.message.match(/ECONNREFUSED/)) {
			// Let Redis client automatically reconnect
		} else if (err.message.match(/Server already opened/)) {
			// This shit happens after client reconnected, maybe a bug with redis client, I couldn't find out :/
			// Quick 'n dirty fix, very incompatible with high-concurrency access : regenerate client
			console.log('RECONNECTION ERROR ! Recreating client')
			client.end()
			client = null
			this.open(function(err) {
				console.log('CLIENT RECREATED')
			})
		} else {
			console.log(err)
		}
	},

	configure: function(options, callback) {
		config = options
		callback()
	},

	open: function(callback) {
		client = redis.createClient();
		client.on("connect", function(err) {
			if (typeof config.redis_db != 'undefined') {
				client.select(config.db)
			}
			if (callback) {
				callback(err)
			}
		})
		client.on("error", function(err) {
			Provider.onError(err)
		})
	},

	close: function(callback) {
		client.quit(callback);
	},

	encode: function(url, options, callback) {
		if (typeof options == 'string') {
			options = {key:options, new:false}
		}
		if (typeof callback == 'undefined' && typeof custom_key == 'function') {
			callback = custom_key
			custom_key = undefined
		}
		this.check(url, function(url) {
			l2s = key_long2short(url)
			if (options.key) {
				// Encode using custom key
				s2l = key_short2long(options.key)
				client.get(s2l, function(err, old_url) {
					if (err) {
						callback(err, options.key, url, false)
					} else if (old_url) {
						// There is already a url encoded with this key
						if (old_url != url) {
							// This is a problem
							callback(new Error('Already used for ' + old_url), options.key, url, false)
						} else {
							// Nothing to do
							callback(err, options.key, url, false)
						}
					} else {
						// do encode
						client.setnx(s2l, url, function(err, added) {
							if (err) {
								// Failed storing short key -> long url
								callback(err, options.key, url, false)
							} else if (added) {
								// Added short key -> long url, do not store long url -> short key as it's private
								callback(err, options.key, url, true)
							} else {
								// Key already used, this can happen only in case of concurrent access
								client.get(s2l, function(err, old_url) {
									if (err) {
										callback(err, options.key, url, false)
									} else {
										callback(new Error('Already used for ' + old_url), options.key, old_url, false)
									}
								})
							}
						})
					}
				})
			} else {
				// Encode using a generated key
				var shorten = function(storeCallback) {
					// Shorten url : generate unique key and register it
					client.incr(config.incr_key || "url:count", function(err, x) {
						if (err) {
							callback(err)
						} else {
							key = conv.decTo62(x)
							s2l = key_short2long(key)
							storeCallback(s2l, url, l2s, key, callback)
						}
					})
				}
				if (!options.private) {
					// Check if URL is already shortened, or create a new key
					client.get(l2s, function(err, key) {
						if (err) {
							callback(err, key, url, false)
						} else if (key != null) {
							// Already shortened : return found key
							callback(err, key, url, false)
						} else {
							shorten(function(s2l, url, l2s, key, callback) {
								// Public shortening : store bilateral relation
								client.msetnx(s2l, url, l2s, key, function(err, added) {
									callback(err, key, url, added)
								})
							})
						}
					})
				} else {
					// Force a new generated key for this URL, without checking if it's already shortened
					shorten(function(s2l, url, l2s, key, callback) {
						// Private shortening : store only short -> long relation
						client.setnx(s2l, url, function(err, added) {
							callback(err, key, url, added)
						})
					})
				}
			}
		})
	},

	decode: function(key, callback) {
		client.get("url:" + key + ":long", callback)
	}

}

module.exports = Provider