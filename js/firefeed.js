
/**
 * The Firefeed object is the primary conduit to the data feed. It provides
 * functions to login a user, log them out, and most importantly, to register
 * callbacks for events like receiving a new message, or a new suggested user
 * to follow. This object knows nothing about the UI, see firefeed-ui.js for
 * how this object is used to make sure the UI is updated as events come in.
 *
 * @param    {string}    baseURL     The Firebase URL.
 * @param    {string}    authURL     The authentication endpoint.
 * @return   {Firefeed}
 */
function Firefeed(baseURL, authURL) {
  this._user = null;
  this._firebase = null;
  this._mainUser = null;

  if (!baseURL || typeof baseURL != "string") {
    throw new Error("Invalid baseURL provided");
  }
  this._baseURL = baseURL;

  if (!authURL || typeof authURL != "string") {
    throw new Error("Invalid authURL provided");
  }
  this._authURL = authURL;
}
Firefeed.prototype = {
  _validateCallback: function _validateCallback(cb) {
    if (!cb || typeof cb != "function") {
      throw new Error("Invalid onComplete callback provided");
    }
  },
  _validateString: function _validateString(str, name) {
    if (!str || typeof str != "string") {
      throw new Error("Invalid " + name + " provided");
    }
  }
};

/**
 * Login a given user. The provided callback will be called with (err, user)
 * where "err" will be false if the login succeeded. If any other methods on
 * this object are called without the login having succeeded, the behaviour
 * in undefined.
 *
 * @param    {string}    user        The user to login as.
 * @param    {Function}  onComplete  The callback to call when login is done.
 */
Firefeed.prototype.login = function(user, onComplete) {
  var self = this;
  self._validateString(user, "user");
  self._validateCallback(onComplete);
  $.ajax({
    type: "POST",
    url: self._authURL + "/login",
    data: {user: user || ""},
    dataType: "json",
    success: function(data) {
      self._user = data.user;
      var ref = new Firebase(self._baseURL);
      ref.auth(data.token, function(done) {
        if (done) {
          self._firebase = ref;
          self._mainUser = ref.child("users").child(user);
          ref.child("people").child(user).set("online");
          onComplete(false, self._user);
        } else {
          onComplete(new Error("Could not auth to Firebase"), false);
        }
      });
    },
    error: function(xhr, status, error) {
      onComplete(error, null);
    }
  });
};

/**
 * Logout the current user. No functions can be called on this object without
 * subsequent successful login. The provided callback will be called with
 * (err, done) where "err" will be false if the login succeeded.
 *
 * @param    {string}    user        The user to login as.
 * @param    {Function}  onComplete  The callback to call when logout is done.
 */
Firefeed.prototype.logout = function(onComplete) {
  var self = this;
  self._validateCallback(onComplete);
  $.ajax({
    type: "POST",
    url: self._authURL + "/logout",
    success: function(data) {
      self._firebase.child("people").child(self._user).set("offline");
      self._firebase.unauth();
      self._firebase = null;
      self._mainUser = null;
      self._user = null;
      onComplete(false, true);
    },
    error: function(xhr, status, error) {
      onComplete(error, false);
    }
  });
};

/**
 * Follow a particular user, on behalf of the user who is currently logged in.
 * The provided callback will be called with (err, done) where "err" will be
 * false if the follow operation succeeded.
 *
 * @param    {string}    user        The user to follow.
 * @param    {Function}  onComplete  The callback to call when follow is done.
 */
Firefeed.prototype.follow = function(user, onComplete) {
  var self = this;
  self._validateString(user, "user");
  self._validateCallback(onComplete);

  // First, we add the user to the "following" list of the current user.
  self._mainUser.child("following").child(user).set(true, function(done) {
    if (!done) {
      onComplete(new Error("Could not follow user"), false);
      return;
    }

    // Then, we add the current user to the folowers list of user just followed.
    var followUser = self._firebase.child("users").child(user);
    followUser.child("followers").child(self._user).set(true);

    // Last, we copy all previous sparks generated by the user just followed
    // to the stream of the current user so they will be displayed.
    // NOTE: this will result in the onNewSpark callback being called, so
    // as soon as a follow is complete, sparks will instantly appear!
    var myStream = self._mainUser.child("stream");
    followUser.child("sparks").once("value", function(sparkSnap) {
      sparkSnap.forEach(function(spark) {
        myStream.child(spark.name()).set(true);
      });
    });

    // All done!
    onComplete(false, user);
  });
};

/**
 * Post a spark as the current user. The provided callbac will be called with
 * (err, done) where "err" will be false if the post succeeded.
 *
 * @param    {string}    content     The content of the spark in text form.
 * @param    {Function}  onComplete  The callback to call when the post is done.
 */
Firefeed.prototype.post = function(content, onComplete) {
  var self = this;
  self._validateString(content, "spark");
  self._validateCallback(onComplete);
  
  // First, we add the spark to the global sparks list. push() ensures that
  // we get a unique ID for the spark that is chronologically ordered.
  var sparkRef = self._firebase.child("sparks").push();
  sparkRef.set({author: self._user, content: content}, function(done) {
    if (!done) {
      onComplete(new Error("Could not post spark"), false);
      return;
    }

    // Now we add a "reference" to the spark we just pushed, by adding it to
    // the sparks list for the current user.
    var streamSparkRef = self._mainUser.child("sparks").child(sparkRef.name());
    streamSparkRef.set(true, function(done) {
      if (!done) {
        onComplete(new Error("Could not add spark to stream"), false);
        return;
      }

      // Finally, we add the spark ID to the stream of everyone who follows
      // the current user. This "fan-out" approach scales well!
      self._mainUser.child("followers").once("value", function(followerList) {
        followerList.forEach(function(follower) {
          if (!follower.val()) {
            return;
          }
          var childRef = self._firebase.child("users").child(follower.name());
          childRef.child("stream").child(sparkRef.name()).set(true);
        });
      });

      // All done!
      onComplete(false, true);
    });
  });
};

/**
 * Register a callback to be notified when a new "suggested" user to follow
 * is added to the site. Currently, a suggested user is any user that isn't
 * the current user or someone the current user doesn't follow. As the site
 * grows, this can be evolved in a number of different ways.
 *
 * @param    {Function}  onComplete  The callback to call whenever a new
 *                                   suggested user appears. The function is
 *                                   invoked with a single argument containing
 *                                   the user ID of the suggested user.
 */
Firefeed.prototype.onNewSuggestedUser = function(onComplete) {
  var self = this;
  if (!onComplete || typeof onComplete != "function") {
    throw new Error("Invalid onComplete callback provided");
  }

  // First, get the current list of users the current user is following,
  // and make sure it is updated as needed.
  var followerList = [];
  var following = self._mainUser.child("following");

  following.on("value", function(followSnap) {
    followerList = Object.keys(followSnap.val() || {});

    // Now, whenever a new user is added to the site, invoke the callback
    // if we decide that they are a suggested user.
    self._firebase.child("people").on("child_added", function(peopleSnap) {
      var user = peopleSnap.name();
      if (user == self._user || followerList.indexOf(user) >= 0) {
        return;
      }
      onComplete(user);
    });
  });
};

/**
 * Register a callback to be notified whenever a new spark appears on the
 * current user's list. This is usually triggered by another user posting a
 * spark (see Firefeed.post), which will appear in real-time on the current
 * user's feed!
 *
 * @param    {Function}  onComplete  The callback to call whenever a new spark
 *                                   appears on the current user's stream. The
 *                                   function will be invoked with a single
 *                                   argument, an object containing the
 *                                   "author" and "content" properties.
 */
Firefeed.prototype.onNewSpark = function(onComplete) {
  var self = this;
  if (!onComplete || typeof onComplete != "function") {
    throw new Error("Invalid onComplete callback provided");
  }

  // We simply listen for new children on the current user's stream.
  self._mainUser.child("stream").on("child_added", function(sparkRefSnap) {
    var sparkID = sparkRefSnap.name();

    // When a new spark is added, fetch the content from the master spark list
    // since streams only contain references in the form of spark IDs.
    var sparkRef = self._firebase.child("sparks").child(sparkID);
    sparkRef.on("value", function(sparkSnap) {
      onComplete(sparkSnap.name(), sparkSnap.val());
    });
  });
};
