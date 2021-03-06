
/**
 * The PublicPredictions object is the primary conduit to the data feed. It provides
 * functions to login a user, log them out, and most importantly, to register
 * callbacks for events like receiving a new message, or a new suggested user
 * to follow. This object knows nothing about the UI, see publicpredictions-ui.js for
 * how this object is used to make sure the UI is updated as events come in.
 *
 * @param    {string}    baseURL     The Firebase URL.
 * @param    {boolean}   newContext  Whether a new Firebase context is used.
 *                                   (Useful for testing only)
 * @return   {PublicPredictions}
 */
function PublicPredictions(baseURL, newContext) {
  var self = this;
  this._name = null;
  this._facebookId = null;
  this._firebase = null;
  this._mainUser = null;
  this._fullName = null;
  this._searchHandler = null;
  this._currentSearch = null;
  this._baseURL = baseURL;

  // Every time we call firebaseRef.on, we need to remember to call .off,
  // when requested by the caller via unload(). We'll store our handlers
  // here so we can clear them later.
  this._handlers = [];

  if (!baseURL || typeof baseURL != "string") {
    throw new Error("Invalid baseURL provided");
  }
  this._firebase = new Firebase(
    baseURL, newContext || false ? new Firebase.Context() : null
  );

  this._authHandlers = [];
  this._firebase.onAuth(self._onLoginStateChange.bind(self));
}
PublicPredictions.prototype = {
  _validateCallback: function(cb, notInit) {
    if (!cb || typeof cb != "function") {
      throw new Error("Invalid onComplete callback provided");
    }
    if (!notInit) {
      if (!this._uid || !this._firebase) {
        throw new Error("Method called without a preceding login() call");
      }
    }
  },
  _validateString: function(str, name) {
    if (!str || typeof str != "string") {
      throw new Error("Invalid " + name + " provided");
    }
  },
  _getParameterByName: function(name) {
    var expr = "[?&]" + name + "=([^&]*)";
    var match = RegExp(expr).exec(window.location.search);
    return match && decodeURIComponent(match[1].replace(/\+/g, " "));
  },
  _getPicURL: function(id, large) {
    if (id) {
      id = id.replace('facebook:', '');
    }
    return "https://graph.facebook.com/" + (id || this._uid.replace('facebook:', '')) +
           "/picture/?type=" + (large ? "large" : "square") +
           "&return_ssl_resources=1";
  },
  _onNewPredictionForFeed: function(feed, onComplete, onOverflow) {
    var self = this;

    // We listen for new children on the feed.
    var handler = feed.on("child_added", function(snap) {
      // When a new prediction is added, fetch the content from the master prediction
      // list since feeds only contain references in the form of prediction IDs.
      var predictionID = snap.name();
      var predictionRef = self._firebase.child("predictions").child(predictionID);
      var handler = predictionRef.on("value", function(predictionSnap) {
        var ret = predictionSnap.val();
        if (ret !== null) {
          ret.pic = self._getPicURL(ret.author);
          onComplete(predictionSnap.name(), ret);
        }
      });
      self._handlers.push({
        ref: predictionRef, handler: handler, eventType: "value"
      });
    });
    self._handlers.push({
      ref: feed, handler: handler, eventType: "child_added"
    });

    // Also listen for child_removed so we can call onOverflow appropriately.
    handler = feed.on("child_removed", function(snap) {
      onOverflow(snap.name());
    });
    self._handlers.push({
      ref: feed, handler: handler, eventType: "child_removed"
    });
  },
  _onLoginStateChange: function(user) {

    var self = this;
    if (user) {
      // The user is successfully logged in.
      this.onLogin(user);
    } else {
      // No existing session found - the user is logged out.
      this.onLogout();
    }
  },
  onStateChange: function(cb) {
    this._firebase.onAuth(cb.bind(this));
  }
};

/**
 * Attach a callback method to be invoked whenever the authentication state
 * of the user changes. If an error occurs during authentication, the error
 * object will be non-null. If a user is successfully authenticated, the error
 * object will be null, and the user object will be non-null. If a user is
 * simply logged-out, both the error and user objects will be null.
 */
PublicPredictions.prototype.onLoginStateChange = function(onLoginStateChange) {
  var self = this;
  self._validateCallback(onLoginStateChange, true);
  this._authHandlers.push(onLoginStateChange);
};

/**
 * Login a user using Firebase Simple Login, using the specified authentication
 * provider. Pass the optional 'rememberMe' argument to the FirebaseSimpleLogin
 * in order to create a long-lasting session. If the user is successfully
 * authenticated, then the previously-configured callback will be invoked with
 * a null error and a user object.
 *
 * @param    {string}    provider    The authentication provider to use.
 */
PublicPredictions.prototype.login = function(provider) {
  this._firebase.authWithOAuthPopup(provider, this.onLogin.bind(this));
};

/**
 * Logout the current user. The user object may be reused after a logout, but
 * only after a successful login() has been performed. After a logout occurs,
 * the session data will be cleared and writing data will no longer be
 * permitted, as configured by security rules.
 */
PublicPredictions.prototype.logout = function() {
  if (this._uid) {
    // Set presence to offline, reset all instance variables, and return!
    var peopleRef = this._firebase.child("people").child(this._uid);
    peopleRef.child("presence").set("offline");
  }
  this._firebase.unauth();
};

/**
 * On successful authentication, set up Firebase references and hang on to
 * relevant user data like id and name. Firebase Simple Login automatically
 * sessions the user using a combination of browser cookies and local storage
 * so there is no need to do any additional sessioning here.
 */

PublicPredictions.prototype.onLogin = function(user) {
  var self = this;
  if (!user) { return; }

  this._uid = user.uid;
  this._facebookId = user.facebook.id;

  // adapt model to old scheme
  var displayName = user.facebook.displayName.split(' ');
  user.first_name = displayName[0];
  user.last_name = displayName[displayName.length - 1];
  user.id = user.uid;
  user.name = user.facebook.displayName;
  user.location = '';
  user.bio = '';
  user.pic = this._getPicURL(user.id, false);

  // Populate search index
  var firstNameKey = [user['first_name'], user['last_name'], user['id']].join('|').toLowerCase();
  var lastNameKey = [user['last_name'], user['first_name'], user['id']].join('|').toLowerCase();
  this._firebase.child('search/firstName').child(firstNameKey).set(user['id']);
  this._firebase.child('search/lastName').child(lastNameKey).set(user['id']);

  this._mainUser = self._firebase.child("users").child(this._uid);
  this._fullName = user.name;
  this._name = user.first_name;

  var peopleRef = self._firebase.child("people").child(this._uid);
  peopleRef.once("value", function(peopleSnap) {
    var info = {};
    var val = peopleSnap.val();
    if (!val) {
      // If this is a first time login, upload user details.
      info = {
        name: self._name,
        fullName: self._fullName,
        location: "",
        bio: "",
        pic: self._getPicURL()
      };
      peopleRef.set(info);
    } else {
      info = val;
    }
    peopleRef.child("presence").set("online");
    info.id = self._uid;
    self._user = info;

    // Notify downstream listeners for new authenticated user state
    for (var i = 0; i < self._authHandlers.length; i++) {
      self._authHandlers[i](null, self._user);
    }
  });
}

/**
 * On logout, clean up by removing expired user session data and marking
 * the current user as offline. Firebase Simple Login automatically handles
 * user sessions, so there is no need to do any additional sessioning here.
 */
PublicPredictions.prototype.onLogout = function() {
  this._user = null;
  this._facebookId = null;
  this._mainUser = null;
  this._fullName = null;
  this._name = null;

  // Notify downstream listeners for new authenticated user state
  var self = this;
  for (var i = 0; i < this._authHandlers.length; i++) {
    self._authHandlers[i](null, null);
  }
};

/**
 * Get information on a particular user, given a user ID. You do not need
 * to be authenticated to make this call. The onComplete callback will be
 * provided an object as a single argument, containing the same fields as the
 * object returned by login(), except that "pic" will point to the URL of a
 * larger image.
 *
 * onComplete may be called multiple time if user information changes. Make
 * sure to update your DOM accordingly.
 *
 * @param    {string}    user        The user to get information for.
 * @param    {Function}  onComplete  The callback to call with the user info.
 */
PublicPredictions.prototype.getUserInfo = function(user, onComplete,
                                          onFollower, onFollowersComplete,
                                          onFollowee, onFolloweesComplete) {
  var self = this;
  self._validateCallback(onComplete, true);

  var ref = self._firebase.child("people").child(user);
  var handler = ref.on("value", function(snap) {
    var val = snap.val();
    val.pic = self._getPicURL(snap.name(), true);
    val.bio = val.bio.substr(0, 141);
    val.location = val.location.substr(0, 80);
    onComplete(val);
  });
  self._handlers.push({
    ref: ref, handler: handler, eventType: "value"
  });

  var userRef = self._firebase.child('users').child(user);
  var followerRef = userRef.child('followers');
  var followerHandle = followerRef.on('child_added', function(snapshot) {
    self._firebase.child('people').child(snapshot.name()).once('value', function(snap) {
      var userInfo = snap.val();
      userInfo['userId'] = snapshot.name();
      if (onFollower) onFollower(userInfo);
    });
  });
  self._handlers.push({
    ref: followerRef, handle: followerHandle, eventType: 'child_added'
  });
  followerRef.once('value', function(snap) {
    if (onFollowersComplete) onFollowersComplete();
  });

  var followeeRef = userRef.child('following');
  var followeeHandle = followeeRef.on('child_added', function(snapshot) {
    self._firebase.child('people').child(snapshot.name()).once('value', function(snap) {
      var userInfo = snap.val();
      userInfo['userId'] = snapshot.name();
      if (onFollowee) onFollowee(userInfo);
    });
  });
  self._handlers.push({
    ref: followeeRef, handle: followeeHandle, eventType: 'child_added'
  });
  followeeRef.once('value', function(snap) {
    if (onFolloweesComplete) onFolloweesComplete();
  });
};


PublicPredictions.prototype.startSearch = function(resultsHandler) {
  this._searchHandler = resultsHandler;
};

PublicPredictions.prototype.updateSearchTerm = function(term) {
  var isValidStem = function(stem) {
    var invalid = ['.', '#', '$', '/', '[', ']'];
    for (var i = 0; i < invalid.length; ++i) {
      if (stem.indexOf([invalid[i]]) !== -1) {
        return false;
      }
    }
    return true;
  };

  if (isValidStem(term) && term.length >= 3) {
    if (this._currentSearch) {
      // we have an existing search
      if (this._currentSearch.containsTerm(term)) {
        // update the term
        this._currentSearch.updateTerm(term);
      } else {
        // stop the search
        this.stopSearching();
      }
    } else {
      // This is a new search
      this._currentSearch = new PublicPredictionsSearch(this._firebase, term, this._searchHandler);
    }
  } else {
    this.stopSearching();
  }
};

PublicPredictions.prototype.stopSearching = function() {
  if (this._currentSearch) {
    this._currentSearch.stopSearch();
    this._currentSearch = null;
  }
  this._searchHandler && this._searchHandler([]);
};

/**
 * Get information on a particular prediction, given a prediction ID. You do not need
 * to be authenticated to make this call. The onComplete callback will be
 * provided an object as a single argument, containing the same fields as the
 * object returned by onNewPrediction().
 *
 * onComplete will be called only once as predictions cannot be modified once they
 * are posted (see rules.json).
 *
 * @param    {string}    id          The prediction ID of the prediction to be fetched.
 * @param    {Function}  onComplete  The callback to call with the prediction.
 */
PublicPredictions.prototype.getPrediction = function(id, onComplete) {
  var self = this;
  self._validateCallback(onComplete, true);
  self._firebase.child("predictions").child(id).once("value", function(snap) {
    onComplete(snap.val());
  });
};

/**
 * Follow a particular user, on behalf of the user who is currently logged in.
 * The provided callback will be called with (err, done) where "err" will be
 * false if the follow operation succeeded. You need to be authenticated
 * through login() to use this function.
 *
 * @param    {string}    user        The user to follow.
 * @param    {Function}  onComplete  The callback to call when follow is done.
 */
PublicPredictions.prototype.follow = function(user, onComplete) {
  var self = this;
  self._validateString(user, "user");
  self._validateCallback(onComplete);

  // First, we add the user to the "following" list of the current user.
  self._mainUser.child("following").child(user).set(true, function(err) {
    if (err) {
      onComplete(new Error("Could not follow user"), false);
      return;
    }

    // Then, we add the current user to the followers list of user just followed.
    var followUser = self._firebase.child("users").child(user);
    followUser.child("followers").child(self._uid).set(true);

    // Last, we copy all previous predictions generated by the user just followed
    // to the feed of the current user so they will be displayed.
    // NOTE: this will result in the onNewPrediction callback being called, so
    // as soon as a follow is complete, predictions will instantly appear!
    var myFeed = self._mainUser.child("feed");
    followUser.child("predictions").once("value", function(predictionSnap) {
      predictionSnap.forEach(function(prediction) {
        myFeed.child(prediction.name()).set(true);
      });
    });

    // All done!
    onComplete(false, user);
  });
};

/**
 * Post a prediction as the current user. The provided callback will be called with
 * (err, done) where "err" will be false if the post succeeded, and done will
 * be set to the ID of the prediction just posted. You need to be authenticated
 * through login() to use this function.
 *
 * @param    {string}    content     The content of the prediction in text form.
 * @param    {Function}  onComplete  The callback to call when the post is done.
 */
PublicPredictions.prototype.post = function(content, onComplete) {
  var self = this;
  self._validateString(content, "prediction");
  self._validateCallback(onComplete);

  // First, we add the prediction to the global predictions list. push() ensures that
  // we get a unique ID for the prediction that is chronologically ordered.
  var predictionRef = self._firebase.child("predictions").push();
  var predictionRefId = predictionRef.name();
  var prediction = {
    author: self._uid, // uid for v2 security rules
    by: self._fullName,
    content: content,
    timestamp: new Date().getTime()
  };

  predictionRef.set(prediction, function(err) {
    if (err) {
      onComplete(new Error("Could not post prediction"), false);
      return;
    }

    // Now we add a "reference" to the prediction we just pushed, by adding it to
    // the predictions list for the current user.
    var feedPredictionRef = self._mainUser.child("predictions").child(predictionRefId);
    feedPredictionRef.set(true, function(err) {
      if (err) {
        onComplete(new Error("Could not add prediction to feed"), false);
        return;
      }

      // Then, we add the prediction ID to the users own feed.
      self._mainUser.child("feed").child(predictionRefId).set(true);

      // We also add ourself (with priority) to a list of users with recent
      // activity which we can use elsewhere to see "active" users.
      var time = new Date().getTime();
      var recentUsersRef = self._firebase.child("recent-users");

      recentUsersRef.child(self._uid).setWithPriority(true, time);

      // We'll also add the prediction to a separate list of most recent predictions
      // which can be displayed elsewhere, just like active users above.
      var recentPredictionRef = self._firebase.child("recent-predictions");
      recentPredictionRef.child(predictionRefId).setWithPriority(true, time);

      // Finally, we add the prediction ID to the feed of everyone who follows
      // the current user.
      self._mainUser.child("followers").once("value", function(followerList) {
        followerList.forEach(function(follower) {
          if (!follower.val()) {
            return;
          }
          var childRef = self._firebase.child("users").child(follower.name());
          childRef.child("feed").child(predictionRefId).set(true);
        });
      });

      // All done!
      onComplete(false, predictionRefId);
    });
  });
};

/**
 * Get a set of "suggested" users to follow.  For now this is just a list of 5
 * users with recent activity, who you aren't already following.  As the site
 * grows, this can be evolved in a number of different ways.
 *
 * The callback is invoked with two arguments, first the userid, and second
 * an object, containing the same fields as the info object returned by login
 * i.e. (name, pic, location, bio).
 *
 * You need to be authenticated through login() to use this function.
 *
 * @param    {Function}  onSuggestedUser  The callback to call for each
 *                                        suggested user.
 */
PublicPredictions.prototype.getSuggestedUsers = function(onSuggestedUser) {
  var self = this;
  self._validateCallback(onSuggestedUser);

  // First, get the current list of users the current user is following,
  // and make sure it is updated as needed.
  var followerList = [];
  self._mainUser.child("following").once("value", function(followSnap) {
    followerList = [];
    var snap = followSnap.val() || {};
    for (var k in snap) {
      if (snap.hasOwnProperty(k)) {
        followerList.push(k);
      }
    }

    // We limit to 20 to try to ensure that there are at least 5 you aren't
    // already following.
    var recentUsersQuery = self._firebase.child("recent-users").limit(20);
    var count = 0;

    var recentUsersRef = self._firebase.child("recent-users");
    recentUsersRef.once("value", function(recentUsersSnap) {
      recentUsersSnap.forEach(function(recentUserSnap) {
        if (count >= 5) {
          return true; // Stop enumerating.
        }
        var userid = recentUserSnap.name();
        if (userid == self._uid || followerList.indexOf(userid) >= 0) {
          return; // Skip this one.
        }
        count++;
        // Now look up their user info and call the onComplete callback.
        self.getUserInfo(userid, function(userInfo) {
          onSuggestedUser(userid, userInfo);
        });
      });
    });
  });
};

/**
 * Set one of our profile fields (e.g. bio, location, etc.)
 *
 * @param    {string}    field       The name of the field (e.g. 'bio').
 * @param    {Object}    value       The new value to write.
 */
PublicPredictions.prototype.setProfileField = function(field, value) {
  var peopleRef = this._firebase.child("people").child(this._uid);
  peopleRef.child(field).set(value);
};

/**
 * Register a callback to be notified whenever a new prediction appears on the
 * current user's list. This is usually triggered by another user posting a
 * prediction (see PublicPredictions.post), which will appear in real-time on the current
 * user's feed!
 *
 * You can limit the number of predictions that you'll get by passing a number as
 * the first argument. The onComplete callback will called only for the 100
 * latest predictions. The callback will also be called for any predictions that are
 * added subsequently, but if the total number of predictions exceeds the number
 * provided, the onOverflow callback will be called to compensate.
 *
 * To hook this up to the DOM, simply display a prediction in your onComplete
 * callback, but also remove the prediction in the onOverflow callback. This will
 * ensure that the total number of predictions displayed on your page will never
 * exceed the number specified (default is 100).
 *
 * You need to be authenticated through login() to use this function.
 *
 * @param    {number}    totalCount  The maximum number of predictions to report.
 *                                   If new predictions are added after this event
 *                                   handler is set, they will also be reported
 *                                   but the onOverflow callback will be
 *                                   invoked with the oldest predictions to
 *                                   compensate.
 *
 * @param    {Function}  onComplete  The callback to call whenever a new prediction
 *                                   appears on the current user's feed. The
 *                                   function will be invoked with two
 *                                   arguments, the first of which is the prediction
 *                                   ID and the second an object containing the
 *                                   "author", "by", "pic" and "content"
 *                                   properties.
 *
 * @param    {Function}  onOverflow  The callback that will be called when
 *                                   onComplete has already been called
 *                                   totalCount times, to keep the total number
 *                                   of reported predictions capped at totalCount.
 *                                   This will be called with one argument,
 *                                   the prediction ID of the prediction expected to
 *                                   removed (the oldest prediction).
 */
PublicPredictions.prototype.onNewPrediction = function(totalCount, onComplete, onOverflow) {
  this._validateCallback(onComplete);
  this._validateCallback(onOverflow);

  var feed = this._mainUser.child("feed").limit(totalCount || 100);
  this._onNewPredictionForFeed(feed, onComplete, onOverflow);
};


/**
 * Register a callback to be notified whenever a given user posts a new prediction.
 * Since all predictions are public, you do not need to be authenticated to
 * set this event handler. The parameters of this function behave exactly
 * like onNewPrediction, except that the predictions returned are always for the
 * specified user.
 *
 * You do not need to be authenticated to use this function.
 *
 * @param    {string}    id          The user ID from whom the predictions are
 *                                   fetched. Defaults to 10.
 * @param    {number}    count       The maximum number of predictions to report.
 *
 * @param    {Function}  onComplete  The callback to call whenever a new prediction
 *                                   appears on the specified user's feed.
 *
 * @param    {Function}  onOverflow  The callback that will be called when
 *                                   a prediction needs to be evicted.
 */
PublicPredictions.prototype.onNewPredictionFor = function(id, count, onComplete, onOverflow) {
  this._validateCallback(onComplete, true);
  this._validateCallback(onOverflow, true);

  var feed = this._firebase.child("users").child(id).child("predictions");
  feed = feed.limit(count || 10);

  this._onNewPredictionForFeed(feed, onComplete, onOverflow);
}

/**
 * Register a callback to get the latest predictions (default 5). The onComplete and
 * onOverflow handlers will be invoked in the same manner as onNewPredictionFor.
 *
 * You do not need to be authenticated to use this function.
 *
 * @param    {number}    count       The maximum number of predictions to report.
 *
 * @param    {Function}  onComplete  The callback to call whenever a new prediction
 *                                   is added to the latest set.
 *
 * @param    {Function}  onOverflow  The callback that will be called when
 *                                   a prediction needs to be evicted from the
 *                                   latest set.
 */
PublicPredictions.prototype.onLatestPrediction = function(count, onComplete, onOverflow) {
  this._validateCallback(onComplete, true);
  this._validateCallback(onOverflow, true);

  var feed = this._firebase.child("recent-predictions");
  feed = feed.limit(count || 5);

  this._onNewPredictionForFeed(feed, onComplete, onOverflow);
};

/**
 * Unload all event handlers currently registered. You must call this function
 * when you no longer want to receive updates. This is especially important
 * for single page apps, when transistioning between views. It is safe to
 * reuse the PublicPredictions object after calling this and registering new handlers.
 */
PublicPredictions.prototype.unload = function() {
  for (var i = 0; i < this._handlers.length; i++) {
    var ref = this._handlers[i].ref;
    var handler = this._handlers[i].handler;
    var eventType = this._handlers[i].eventType;
    ref.off(eventType, handler);
  }
  this._handlers = [];
};


// Facebook Auth
var firebase = new Firebase("https://publicpredictions.firebaseio.com/");

// monitor state changes and react to updates
var authClient = new FirebaseSimpleLogin(chatRef, function(error, user) {
    if (error) {
        // an error occurred while attempting login
        console.log(error);
    } else if (user) {
        // user authenticated with Firebase
        console.log('User ID: ' + user.id + ', Provider: ' + user.provider);
    } else {
        // user is logged out
    }
});

// perform the login (to Facebook in this case)
authClient.login('facebook');