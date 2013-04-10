/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

module.metadata = {
  "stability": "unstable"
};

const { Cc, Ci } = require("chrome");
const { setTimeout } = require("../timers");
const { platform } = require("../system");
const { getMostRecentBrowserWindow, getOwnerBrowserWindow,
        getHiddenWindow } = require("../window/utils");
const { create: createFrame, swapFrameLoaders } = require("../frame/utils");
const { window: addonWindow } = require("../addon/window");
const events = require("../system/events");


const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

function open(panel, width, height, anchor) {
  // Wait for the XBL binding to be constructed
  if (!panel.openPopup) setTimeout(open, 50, panel, width, height, anchor);
  else display(panel, width, height, anchor);
}
exports.open = open;

function isOpen(panel) {
  return panel.state === "open"
}
exports.isOpen = isOpen;


function close(panel) {
  // Sometimes "TypeError: panel.hidePopup is not a function" is thrown
  // when quitting the host application while a panel is visible.  To suppress
  // these errors, check for "hidePopup" in panel before calling it.
  // It's not clear if there's an issue or it's expected behavior.

  return panel.hidePopup && panel.hidePopup();
}
exports.close = close


function resize(panel, width, height) {
  // Resize the iframe instead of using panel.sizeTo
  // because sizeTo doesn't work with arrow panels
  panel.firstChild.style.width = width + "px";
  panel.firstChild.style.height = height + "px";
}
exports.resize = resize

function display(panel, width, height, anchor) {
  let document = panel.ownerDocument;
  let x = null;
  let y = null;
  let position = null;

  // Panel XBL has some SDK incompatible styling decisions. We shim panel
  // instances until proper fix for Bug 859504 is shipped.
  shimDefaultStyle(panel);

  if (!anchor) {
    // Open the popup in the middle of the window.
    x = document.documentElement.clientWidth / 2 - width / 2;
    y = document.documentElement.clientHeight / 2 - height / 2;
    position = null;
  }
  else {
    // Open the popup by the anchor.
    let rect = anchor.getBoundingClientRect();

    let window = anchor.ownerDocument.defaultView;

    let zoom = window.mozScreenPixelsPerCSSPixel;
    let screenX = rect.left + window.mozInnerScreenX * zoom;
    let screenY = rect.top + window.mozInnerScreenY * zoom;

    // Set up the vertical position of the popup relative to the anchor
    // (always display the arrow on anchor center)
    let horizontal, vertical;
    if (screenY > window.screen.availHeight / 2 + height)
      vertical = "top";
    else
      vertical = "bottom";

    if (screenY > window.screen.availWidth / 2 + width)
      horizontal = "left";
    else
      horizontal = "right";

    let verticalInverse = vertical == "top" ? "bottom" : "top";
    position = vertical + "center " + verticalInverse + horizontal;

    // Allow panel to flip itself if the panel can't be displayed at the
    // specified position (useful if we compute a bad position or if the
    // user moves the window and panel remains visible)
    panel.setAttribute("flip", "both");
  }

  // Resize the iframe instead of using panel.sizeTo
  // because sizeTo doesn't work with arrow panels
  panel.firstChild.style.width = width + "px";
  panel.firstChild.style.height = height + "px";

  panel.openPopup(anchor, position, x, y);
}
exports.display = display;

// This utility function is just a workaround until Bug 859504 has shipped.
function shimDefaultStyle(panel) {
  let document = panel.ownerDocument;
  // Please note that `panel` needs to be part of document in order to reach
  // it's anonymous nodes. One of the anonymous node has a big padding which
  // doesn't work well since panel frame needs to fill all of the panel.
  // XBL binding is a not the best option as it's applied asynchronously, and
  // makes injected frames behave in strange way. Also this feels a lot
  // cheaper to do.
  ["panel-inner-arrowcontent", "panel-arrowcontent"].forEach(function(value) {
    let node = document.getAnonymousElementByAttribute(panel, "class", value);
      if (node) node.style.padding = 0;
  });
}

function show(panel, width, height, focus, anchor) {
  // Prevent the panel from getting focus when showing up
  // if focus is set to false
  panel.setAttribute("noautofocus", !focus);


  let window = anchor && getOwnerBrowserWindow(anchor);
  let { document } = window ? window : getMostRecentBrowserWindow();
  attach(panel, document);
  open(panel, width, height, anchor);
}
exports.show = show

function setupPanelFrame(frame) {
  frame.setAttribute("flex", 1);
  frame.setAttribute("transparent", "transparent");
  frame.setAttribute("showcaret", true);
  frame.setAttribute("autocompleteenabled", true);
  if (platform === "darwin") {
    frame.style.borderRadius = "6px";
    frame.style.padding = "1px";
  }
}

let EVENT_NAMES = {
  "popupshowing": "sdk-panel-show",
  "popuphiding": "sdk-panel-hide",
  "popupshown": "sdk-panel-shown",
  "popuphidden": "sdk-panel-hidden",
  "document-element-inserted": "sdk-panel-content-changed",
  "DOMContentLoaded": "sdk-panel-content-loaded",
  "load": "sdk-panel-document-loaded"
};

function make(document) {
  document = document || getMostRecentBrowserWindow().document;
  let panel = document.createElementNS(XUL_NS, "panel");
  panel.setAttribute("type", "arrow");

  // Note that panel is a parent of `viewFrame` who's `docShell` will be
  // configured at creation time. If `panel` and there for `viewFrame` won't
  // have an owner document attempt to access `docShell` will throw. There
  // for we attach panel to a document.
  attach(panel, document);

  let frameOptions =  {
    allowJavascript: true,
    allowPlugins: true,
    allowAuth: true,
    allowWindowControl: false,
    // Need to override `nodeName` to use `iframe` as `browsers` save session
    // history and in consequence do not dispatch "inner-window-destroyed"
    // notifications.
    browser: false,
    // Note that use of this URL let's use swap frame loaders earlier
    // than if we used default "about:blank".
    uri: "data:text/plain;charset=utf-8,"
  };

  let backgroundFrame = createFrame(addonWindow, frameOptions);
  setupPanelFrame(backgroundFrame);

  let viewFrame = createFrame(panel, frameOptions);
  setupPanelFrame(viewFrame);

  function onDisplayChange({type}) {
    try { swapFrameLoaders(backgroundFrame, viewFrame); }
    catch(error) { console.exception(error); }
    events.emit(EVENT_NAMES[type], { subject: panel });
  }

  function onContentReady({target, type}) {
    if (target === getContentDocument(panel)) {
      style(panel);
      events.emit(EVENT_NAMES[type], { subject: panel });
    }
  }

  function onContentLoad({target, type}) {
    if (target === getContentDocument(panel))
      events.emit(EVENT_NAMES[type], { subject: panel });
  }

  function onContentChange({subject, type}) {
    let document = subject;
    if (document === getContentDocument(panel) && document.defaultView)
      events.emit(EVENT_NAMES[type], { subject: panel });
  }

  function onPanelStateChange({type}) {
    events.emit(EVENT_NAMES[type], { subject: panel })
  }

  panel.addEventListener("popupshowing", onDisplayChange, false);
  panel.addEventListener("popuphiding", onDisplayChange, false);
  panel.addEventListener("popupshown", onPanelStateChange, false);
  panel.addEventListener("popuphidden", onPanelStateChange, false);

  // Panel content document can be either in panel `viewFrame` or in
  // a `backgroundFrame` depending on panel state. Listeners are set
  // on both to avoid setting and removing listeners on panel state changes.

  panel.addEventListener("DOMContentLoaded", onContentReady, true);
  backgroundFrame.addEventListener("DOMContentLoaded", onContentReady, true);

  panel.addEventListener("load", onContentLoad, true);
  backgroundFrame.addEventListener("load", onContentLoad, true);

  events.on("document-element-inserted", onContentChange);


  panel.backgroundFrame = backgroundFrame;

  // Store event listener on the panel instance so that it won't be GC-ed
  // while panel is alive.
  panel.onContentChange = onContentChange;

  return panel;
}
exports.make = make;

function attach(panel, document) {
  document = document || getMostRecentBrowserWindow().document;
  let container = document.getElementById("mainPopupSet");
  if (container !== panel.parentNode) {
    detach(panel);
    document.getElementById("mainPopupSet").appendChild(panel);
  }
}
exports.attach = attach;

function detach(panel) {
  if (panel.parentNode) panel.parentNode.removeChild(panel);
}
exports.detach = detach;

function dispose(panel) {
  panel.backgroundFrame.parentNode.removeChild(panel.backgroundFrame);
  panel.backgroundFrame = null;
  events.off("document-element-inserted", panel.onContentChange);
  panel.onContentChange = null;
  detach(panel);
}
exports.dispose = dispose;

function style(panel) {
  /**
  Injects default OS specific panel styles into content document that is loaded
  into given panel. Optionally `document` of the browser window can be
  given to inherit styles from it, by default it will use either panel owner
  document or an active browser's document. It should not matter though unless
  Firefox decides to style windows differently base on profile or mode like
  chrome for example.
  **/

  try {
    let document = panel.ownerDocument;
    let contentDocument = getContentDocument(panel);
    let window = document.defaultView;
    let node = document.getAnonymousElementByAttribute(panel, "class",
                                                       "panel-arrowcontent") ||
               // Before bug 764755, anonymous content was different:
               // TODO: Remove this when targeting FF16+
                document.getAnonymousElementByAttribute(panel, "class",
                                                        "panel-inner-arrowcontent");

    let color = window.getComputedStyle(node).getPropertyValue("color");

    let style = contentDocument.createElement("style");
    style.id = "sdk-panel-style";
    style.textContent = "body { color: " + color + "; }";

    let container = contentDocument.head ? contentDocument.head :
                    contentDocument.documentElement;

    if (container.firstChild)
      container.insertBefore(style, container.firstChild);
    else
      container.appendChild(style);
  }
  catch (error) {
    console.error("Unable to apply panel style");
    console.exception(error);
  }
}
exports.style = style;

function getContentFrame(panel) isOpen(panel) ? panel.firstChild :
                                                panel.backgroundFrame
exports.getContentFrame = getContentFrame;

function getContentDocument(panel) getContentFrame(panel).contentDocument
exports.getContentDocument = getContentDocument;

function setURL(panel, url) getContentFrame(panel).setAttribute("src", url)
exports.setURL = setURL;