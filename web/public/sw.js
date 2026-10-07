// SPDX-License-Identifier: Apache-2.0
/*
 * The service worker of the web client: web push only (tavrn-protocol PROTOCOL.md §6d). It shows the notification of
 * a push and opens or focuses the conversation when the notification is clicked. It caches nothing and offers no
 * offline mode: every request goes to the network as without it.
 *
 * The page sends its localized texts and the account's home node (`tavrn.push.config`); they are kept in IndexedDB
 * so a push that wakes the worker without an open page still speaks the user's language. Without them the
 * English defaults below apply.
 *
 * Written as a plain script (no bundler); `tavrnPush` exposes the pure helpers for the tests.
 */
(function (scope) {
  "use strict";

  /** English defaults; the page replaces them with its translations (keys of the `push.sw.*` texts). */
  var DEFAULT_STRINGS = {
    app: "tavrn",
    message: "New message from {sender}",
    message_anonymous: "New message",
    mention: "{sender} mentioned you",
    mention_anonymous: "You were mentioned",
    dm: "New message",
    dm_encrypted: "New encrypted message",
    call: "Incoming call",
    call_from: "{sender} is calling",
    remote_message: "New message on {node}",
    remote_mention: "You were mentioned on {node}",
    remote_dm: "New direct message on {node}",
    test: "Push notifications work on this device.",
    generic: "New notification",
  };

  var DB_NAME = "tavrn-push";
  var STORE = "config";

  function fill(template, values) {
    return String(template).replace(/\{(\w+)\}/g, function (_, k) {
      return values[k] != null ? String(values[k]) : "";
    });
  }

  function str(strings, key) {
    return (strings && typeof strings[key] === "string" && strings[key]) || DEFAULT_STRINGS[key];
  }

  /** Route of the web client for a payload; `homeNode` is the account's home node (its rooms need no `/n/` prefix). */
  function targetUrl(p, homeNode) {
    if (!p || typeof p.conversation_id !== "string") return "/";
    var id = encodeURIComponent(p.conversation_id);
    var prefix = !p.node || p.node === homeNode ? "" : "/n/" + encodeURIComponent(p.node);
    if (typeof p.room_id === "string") return prefix + "/rooms/" + encodeURIComponent(p.room_id) + "/channels/" + id;
    return prefix + "/conversations/" + id;
  }

  /** Title and options of the notification for a payload (`null` payload: the generic one). */
  function notificationFor(p, strings, homeNode) {
    var s = function (k) {
      return str(strings, k);
    };
    var app = s("app");
    if (!p || typeof p !== "object") return { title: app, options: { body: s("generic"), tag: "tavrn", data: { url: "/" } } };
    var sender = typeof p.sender === "string" && p.sender ? p.sender : null;
    var place = null;
    if (p.conversation && p.room) place = "#" + p.conversation + " · " + p.room;
    else if (p.room) place = p.room;
    else if (p.conversation) place = p.conversation;
    var title = app;
    var body = s("generic");
    var text = typeof p.text === "string" && p.text ? p.text : null;
    if (p.local === false && p.type !== "call") {
      title = p.node || app;
      body = fill(s(p.type === "mention" ? "remote_mention" : p.type === "dm" ? "remote_dm" : "remote_message"), { node: p.node });
    } else if (p.type === "message" || p.type === "mention") {
      title = place || sender || app;
      body = text ? (sender ? sender + ": " + text : text) : sender ? fill(s(p.type), { sender: sender }) : s(p.type + "_anonymous");
    } else if (p.type === "dm") {
      title = p.conversation ? p.conversation : sender || app;
      var line = text || s(p.encrypted ? "dm_encrypted" : "dm");
      body = p.conversation && sender ? sender + ": " + line : line;
    } else if (p.type === "call") {
      title = p.conversation || sender || app;
      body = sender ? fill(s("call_from"), { sender: sender }) : s("call");
    } else if (p.type === "test") {
      body = s("test");
    } else if (p.type === "notice") {
      title = typeof p.title === "string" && p.title ? p.title : app;
      body = typeof p.body === "string" && p.body ? p.body : s("generic");
    }
    var tag = (p.node || "") + "|" + (p.conversation_id || p.type || "tavrn");
    var important = p.type === "mention" || p.type === "dm" || p.type === "call" || p.type === "test";
    return {
      title: title,
      options: {
        body: body,
        tag: tag,
        // A newer push of the same conversation replaces the shown one; important ones alert again.
        renotify: important,
        requireInteraction: p.type === "call",
        icon: "/icon-192.png",
        badge: "/icon-64.png",
        timestamp: Date.now(),
        data: { url: targetUrl(p, homeNode) },
      },
    };
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }

  function readConfig() {
    return openDb()
      .then(function (db) {
        return new Promise(function (resolve) {
          var get = db.transaction(STORE, "readonly").objectStore(STORE).get("config");
          get.onsuccess = function () {
            resolve(get.result || null);
          };
          get.onerror = function () {
            resolve(null);
          };
        });
      })
      .catch(function () {
        return null;
      });
  }

  function writeConfig(config) {
    return openDb()
      .then(function (db) {
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(config, "config");
          tx.oncomplete = resolve;
          tx.onerror = resolve;
        });
      })
      .catch(function () {
        return undefined;
      });
  }

  function parse(data) {
    if (!data) return null;
    try {
      var p = data.json();
      return p && typeof p === "object" && p.v === 1 ? p : null;
    } catch (e) {
      return null;
    }
  }

  function onPush(event) {
    var payload = parse(event.data);
    event.waitUntil(
      readConfig().then(function (config) {
        var n = notificationFor(payload, config && config.strings, config && config.homeNode);
        return scope.registration.showNotification(n.title, n.options);
      }),
    );
  }

  function onClick(event) {
    event.notification.close();
    var url = (event.notification.data && event.notification.data.url) || "/";
    var target = new URL(url, scope.location.origin).href;
    event.waitUntil(
      scope.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
        var own = windows.filter(function (w) {
          return new URL(w.url).origin === scope.location.origin;
        });
        if (own.length) {
          var w = own[0];
          // The page navigates itself (no reload, the session and keys stay unlocked).
          w.postMessage({ type: "tavrn.push.open", url: url });
          return w.focus();
        }
        return scope.clients.openWindow(target);
      }),
    );
  }

  function onMessage(event) {
    var d = event.data;
    if (d && d.type === "tavrn.push.config") {
      var config = { strings: d.strings && typeof d.strings === "object" ? d.strings : null, homeNode: typeof d.homeNode === "string" ? d.homeNode : null };
      if (event.waitUntil) event.waitUntil(writeConfig(config));
      else writeConfig(config);
    }
  }

  scope.tavrnPush = { notificationFor: notificationFor, targetUrl: targetUrl, DEFAULT_STRINGS: DEFAULT_STRINGS };
  if (typeof scope.addEventListener === "function") {
    scope.addEventListener("install", function () {
      scope.skipWaiting();
    });
    scope.addEventListener("activate", function (event) {
      event.waitUntil(scope.clients.claim());
    });
    scope.addEventListener("push", onPush);
    scope.addEventListener("notificationclick", onClick);
    scope.addEventListener("message", onMessage);
  }
})(self);
