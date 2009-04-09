/**
 * Facebook Firefox Toolbar Software License
 * Copyright (c) 2009 Facebook, Inc.
 *
 * Permission is hereby granted, free of charge, to any person or organization
 * obtaining a copy of the software and accompanying documentation covered by
 * this license (which, together with any graphical images included with such
 * software, are collectively referred to below as the "Software") to (a) use,
 * reproduce, display, distribute, execute, and transmit the Software, (b)
 * prepare derivative works of the Software (excluding any graphical images
 * included with the Software, which may not be modified or altered), and (c)
 * permit third-parties to whom the Software is furnished to do so, all
 * subject to the following:
 *
 * The copyright notices in the Software and this entire statement, including
 * the above license grant, this restriction and the following disclaimer,
 * must be included in all copies of the Software, in whole or in part, and
 * all derivative works of the Software, unless such copies or derivative
 * works are solely in the form of machine-executable object code generated by
 * a source language processor.
 *
 * Facebook, Inc. retains ownership of the Software and all associated
 * intellectual property rights.  All rights not expressly granted in this
 * license are reserved by Facebook, Inc.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO EVENT
 * SHALL THE COPYRIGHT HOLDERS OR ANYONE DISTRIBUTING THE SOFTWARE BE LIABLE
 * FOR ANY DAMAGES OR OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE,
 * ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const CC = Components.Constructor;
const Cu = Components.utils;

const FileInputStream = CC("@mozilla.org/network/file-input-stream;1",
                           "nsIFileInputStream",
                           "init");
const StringInputStream = CC("@mozilla.org/io/string-input-stream;1",
                             "nsIStringInputStream")

// Keep this in sync with the albumid attribute of the default album in photoupload.xul
const DEFAULT_ALBUM = "-1";

// Global objects.

var gFacebookService =  Cc['@facebook.com/facebook-service;1'].
                        getService(Ci.fbIFacebookService);


// Compatibility with Firefox 3.0 that doesn't have native JSON.
// TODO: remove this once the Facebook component is used for requests.
if (typeof(JSON) == "undefined") {
  Components.utils.import("resource://gre/modules/JSON.jsm");
  JSON.parse = JSON.fromString;
  JSON.stringify = JSON.toString;
}

const DEBUG = false;

// Debugging.
function LOG(s) {
  if (DEBUG)
    dump(s + "\n");
}

/**
 * Base class for representing a photo tag.
 */
function Tag(label, x, y) {
  this.label = label;
  this.x = x;
  this.y = y;
}
Tag.prototype = {
  getUploadObject: function() {
    var uploadObject = {
      x: this.x,
      y: this.y
    };
    var [key, value] = this.getUploadObjectKeyValue();
    uploadObject[key] = value;
    return uploadObject;
  }
}

/**
 * Class for text based tags.
 */
function TextTag(text, x, y) {
  Tag.call(this, text, x, y);
  this.text = text;
}
TextTag.prototype = {
  __proto__: Tag.prototype,
  getUploadObjectKeyValue: function() {
    return ["tag_text", this.text];
  }
}

/**
 * Class for people based tags.
 */
function PeopleTag(uid, x, y) {
  // TODO: need both uid and label here.
  Tag.call(this, "todo " + uid, x, y)
  this.uid = uid;
}
PeopleTag.prototype = {
  __proto__: Tag.prototype,
  getUploadObjectKeyValue: function() {
    return ["tag_uid", this.uid];
  }
}

/**
 * This objects represents a photo that is going to be uploaded.
 */
function Photo(/* nsIFile */ file) {
  LOG("Creating new photo " + file);
  this.file = file.QueryInterface(Ci.nsIFile);
  this.caption = "";
  this.tags = [];
  LOG(" Constructed " + this.file);
};

Photo.prototype = {
  get url() {
    var ios = Cc["@mozilla.org/network/io-service;1"].
              getService(Ci.nsIIOService);
    return ios.newFileURI(this.file).spec;
  },
  get sizeInBytes() {
    return this.file.fileSize;
  },
  get filename() {
    return this.file.leafName;
  },
  addTag: function(tag) {
    this.tags.push(tag);
  },
  removeTag: function(tag) {
    this.tags = this.tags.filter(function(p) p != tag);
  }
};

const BOUNDARY = "facebookPhotoUploaderBoundary";

/**
 * This object (singleton) represent the list of photos that will be uploaded
 * or that can be edited.
 */
var PhotoSet = {
  // Array of Photo objects.
  _photos: [],
  // Currently selected Photo object.
  _selected: null,
  // Listeners wanted to get notified when a photo changes.
  // Stored as (function callback, context object) pairs.
  _listeners: [],
  _cancelled: false,

  add: function(aFiles) {
    Array.prototype.push.apply(this._photos, aFiles)

    this._notifyChanged();
  },

  _updateSelected: function() {
    var p = this._photos.filter(function(p) p == this._selected);
    if (p.length > 1) {
      LOG("ERROR: more that once selected photo?");
      return;
    }
    if (p.length == 0) {
      this._selected = null;
    }
  },

  removeAll: function() {
    this._photos = [];
    this._updateSelected();
    this._notifyChanged();
  },

  remove: function(photo) {
    this._photos = this._photos.filter(function(p) p != photo);
    this._updateSelected();
    this._notifyChanged();
  },

  _ensurePhotoExists: function(photo) {
    var p = this._photos.filter(function(p) p == photo);
    if (p.length == 0) {
      LOG("ERROR: photo does not exist in set");
      return false;
    }
    if (p.length > 1) {
      LOG("ERROR: more than one photo matching?");
      return false;
    }
    return true;
  },

  update: function(photo) {
    if (!this._ensurePhotoExists(photo))
      return;

    // The modified photo should be a reference to the photo in the set.
    // So there is nothing to update.

    this._notifyChanged();
  },

  get selected() {
    return this._selected;
  },

  set selected(photo) {
    if (!this._ensurePhotoExists(photo))
      return;
    this._selected = photo;
    this._notifyChanged();
  },

  get photos() {
    return this._photos;
  },

  _notifyChanged: function() {
    this._listeners.forEach(function(listener) {
      var [func, context] = listener;
      func.call(context);
    }, this);
  },

  addChangedListener: function(func, context) {
    this._listeners.push([func, context]);
  },

  removeChangedListener: function(func, context) {
    this._listeners = this._listeners.filter(hasFilter);
    function hasFilter(listener) {
      return listener[0] != func && listener[1] != context;
    }
  },

  _getMimeTypeFromExtension: function(imageExt) {
    var mimeSvc = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService);
    imageExt = imageExt.toLowerCase();
    var dotPos = imageExt.lastIndexOf(".");
    if (dotPos != -1)
      imageExt = imageExt.substring(dotPos + 1, imageExt.length);
    return mimeSvc.getTypeFromExtension(imageExt);
  },

  /**
   * Returns an InputStream with the image data. The photo is resized if too
   * large.
   */
  _maybeResizePhoto: function(photo) {
    const PR_RDONLY = 0x01;
    function getImageInputStream() {
      var fis = new FileInputStream(photo.file, PR_RDONLY, 0444, null);

      var imageStream = Cc["@mozilla.org/network/buffered-input-stream;1"].
                        createInstance(Ci.nsIBufferedInputStream);
      imageStream.init(fis, 4096);
      return imageStream;
    }

    var imgTools = Cc["@mozilla.org/image/tools;1"].
                   getService(Ci.imgITools);

    var filename = photo.filename;
    var extension = filename.substring(filename.lastIndexOf("."),
                                       filename.length).toLowerCase();

    var mimeType = this._getMimeTypeFromExtension(extension);
    LOG("Found mime: " + mimeType + " for file " + filename);
    var outParam = { value: null };
    imgTools.decodeImageData(getImageInputStream(), mimeType, outParam);
    var container = outParam.value;
    LOG("Container: " + container.width + " x " + container.height);

    const MAX_WIDTH = 604;
    const MAX_HEIGHT = 604;

    var imageStream;
    if (container.width < MAX_WIDTH && container.height < MAX_HEIGHT) {
      LOG("No resizing needed");
      return getImageInputStream();
    }
    LOG("resizing image. Original size: " + container.width + " x " +
        container.height);
    var newWidth, newHeight;
    var ratio = container.height / container.width;
    if (container.width > MAX_WIDTH) {
      newWidth = MAX_WIDTH;
      newHeight = container.height * (MAX_WIDTH / container.width);
    } else if (container.height > MAX_HEIGHT) {
      newHeight = MAX_HEIGHT;
      newWidth = container.width * (MAX_HEIGHT / container.height);
    } else {
      LOG("Unexpected state");
    }
    LOG("New size: " + newWidth + " x " + newHeight);
    try {
      return imgTools.encodeScaledImage(container, mimeType, newWidth, newHeight);
    } catch (e) {
      throw "Failure while resizing image: " + e;
    }
  },

  _getUploadStream: function(photo, params) {
    const EOL = "\r\n";

    // Header stream.
    var header = "";

    for (let [name, value] in Iterator(params)) {
      header += "--" + BOUNDARY + EOL;
      header += "Content-disposition: form-data; name=\"" + name + "\"" + EOL + EOL;
      header += value;
      header += EOL;
    }

    header += "--" + BOUNDARY + EOL;
    header += "Content-disposition: form-data;name=\"filename\"; filename=\"" +
              photo.file.leafName + "\"" + EOL;
    // Apparently Facebook accepts binay content type and will sniff the file
    // for the correct image mime type.
    header += "Content-Type: application/octet-stream" + EOL;
    header += EOL;

    // Convert the stream to UTF-8, otherwise bad things happen.
    // See http://developer.taboca.com/cases/en/XMLHTTPRequest_post_utf-8/
    var converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].
                    createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    var headerStream = converter.convertToInputStream(header);

    var mis = Cc["@mozilla.org/io/multiplex-input-stream;1"].
              createInstance(Ci.nsIMultiplexInputStream);
    mis.appendStream(headerStream);

    // Image stream
    mis.appendStream(this._maybeResizePhoto(photo));

    // Ending stream
    var endingStream = new StringInputStream();
    var boundaryString = "\r\n--" + BOUNDARY + "--\r\n";
    endingStream.setData(boundaryString, boundaryString.length);
    mis.appendStream(endingStream);

    return mis;
  },

  _uploadPhoto: function(albumId, photo, onProgress, onComplete, onError) {
    var fbSvc = Cc['@facebook.com/facebook-service;1'].
                getService(Ci.fbIFacebookService);

    // Hack for accessing private members.
    var fbSvc_ = fbSvc.wrappedJSObject;
    LOG("Uploading photo: " + photo);

    var params = {};

    // method specific:
    params.method = "facebook.photos.upload";
    if (albumId != DEFAULT_ALBUM)
      params.aid = albumId;
    if (photo.caption)
      params.caption = photo.caption;

    // TODO: this should be refactored with callMethod in the XPCOM component.
    params.session_key = fbSvc_._sessionKey;
    params.api_key = fbSvc.apiKey;
    params.v = "1.0";
    var callId = Date.now();
    if (callId <= fbSvc_._lastCallId) {
        callId = fbSvc_._lastCallId + 1;
    }
    fbSvc_._lastCallId = callId;
    params.call_id = callId;
    params.format = "JSON";

    // Builds another array of params in the format accepted by generateSig()
    var paramsForSig = [];
    for (let [name, value] in Iterator(params)) {
      paramsForSig.push(name + "=" + value);
    }
    params.sig = fbSvc_.generateSig(paramsForSig);

    const RESTSERVER = 'http://api.facebook.com/restserver.php';

    var xhr = new XMLHttpRequest();

    function updateProgress(event) {
      if (!event.lengthComputable)
        return;
      onProgress((event.loaded / event.total) * 100);
    }

    // Progress handlers have to be set before calling open(). See
    // https://bugzilla.mozilla.org/show_bug.cgi?id=311425

    // The upload property is not available with Firefox 3.0
    if (xhr.upload) {
      xhr.upload.onprogress = updateProgress;
    }

    xhr.open("POST", RESTSERVER);
    xhr.setRequestHeader("Content-Type", "multipart/form-data; boundary=" + BOUNDARY);
    xhr.setRequestHeader("MIME-version", "1.0");

    xhr.onreadystatechange = function(event) {
      LOG("onreadstatechange " + xhr.readyState)
      if (xhr.readyState != 4)
        return;

      try {
        var data = JSON.parse(xhr.responseText);
      } catch(e) {
        onError("Failed to parse JSON", xhr.reponseText);
        return;
      }
      // TODO: refactor with facebook.js::callMethod
      if (typeof data.error_code != "undefined") {
        onError("Server returned an error: " + data.error_msg, data);
        return;
      }
      onComplete(data.pid);
    }
    xhr.onerror = function(event) {
      onError("XMLHttpRequest error", event);
    }

    xhr.send(this._getUploadStream(photo, params));
  },

  _tagPhoto: function(photo, photoId, onComplete, onError) {
    if (photo.tags.length == 0) {
      onComplete()
      return;
    }
    var tagUploadObjects = [tag.getUploadObject() for each (tag in photo.tags)];

    // XXX wrappedJSObject hack because the method is not exposed.
    gFacebookService.wrappedJSObject.callMethod('facebook.photos.addTag',
      [
        "pid=" + photoId,
        "uid=" + gFacebookService.wrappedJSObject._uid,
        "tags=" + JSON.stringify(tagUploadObjects)
      ],
      function(data) {
        if (data !== true) {
          onError("Error during tagging " + data);
          return;
        }
        onComplete();
      }
    );
  },

  _uploadAndTagPhoto: function(albumId, photo, onProgress, onComplete, onError) {
    this._uploadPhoto(albumId, photo, onProgress,
      function(photoId) { // onComplete callback
        PhotoSet._tagPhoto(photo, photoId, onComplete, onError);
      },
    onError);
  },

  upload: function(albumId, onProgress, onComplete, onError) {
    var toUpload = this._photos;
    var total = toUpload.length;
    var index = 0;
    var self = this;

    var totalSizeBytes = [photo.sizeInBytes for each (photo in toUpload)].
                             reduce(function(a, b) a + b);
    var uploadedBytes = 0;

    function doUpload() {
      if (self._cancelled) {
        LOG("Upload cancelled");
        onComplete(true);
        return;
      }
      if (index == total) {
        LOG("PhotoSet.upload: index != total, How could that happen?");
        return;
      }
      var photo = toUpload[index];
      if (!photo) {
        LOG("PhotoSet.upload: no photo to upload, How could that happen?");
        return;
      }
      var photoSize = photo.sizeInBytes;

      try {
        self._uploadAndTagPhoto(albumId, photo,
          function(photoPercent) { // onProgress callback
            LOG("on progress from photo upload " + photoPercent);
            var donePercent = (uploadedBytes / totalSizeBytes) * 100;
            var photoRelativePercent = photoPercent * (photoSize / totalSizeBytes);
            onProgress(donePercent + photoRelativePercent);
          }, function() { // onComplete callback
            index++;
            uploadedBytes += photoSize;
            // Call progress here for Firefox 3.0 which won't get progress
            // notification during image upload.
            onProgress((uploadedBytes / totalSizeBytes) * 100)

            if (index == total) {
              onComplete(false);
              self.removeAll();
            } else {
              doUpload();
            }
          }, onError);
      } catch (e) {
        onError("Failure during upload: " + e);
      }
    }
    doUpload();
  },

  cancelUpload: function() {
    this._cancelled = true;
  }
};

/**
 * Manages the UI for displaying and manipulating the list of photos.
 */
var OverviewPanel = {
  init: function() {
    PhotoSet.addChangedListener(this.photosChanged, OverviewPanel);
  },
  uninit: function() {
    PhotoSet.removeChangedListener(this.photosChanged, OverviewPanel);
  },
  photosChanged: function() {
    LOG("OverviewPanel::PhotosChanged");

    var panelDoc = document.getElementById("overviewPanel").contentDocument;
    var photoContainer = panelDoc.getElementById("photo-container")
    var photoboxTemplate = panelDoc.getElementById("photobox-template")
    var photos = PhotoSet.photos;

    var node = photoContainer.firstChild;
    while (node) {
      var nextNode = node.nextSibling;
      if (node.nodeType == Node.ELEMENT_NODE &&
          node.className == "photobox" &&
          node.id != "photobox-template") {
        photoContainer.removeChild(node);
      }
      node = nextNode;
    }

    photos.forEach(function(photo) {
      var newBox = photoboxTemplate.cloneNode(true);
      newBox.photo = photo;
      newBox.removeAttribute("id");
      if (photo == PhotoSet.selected)
        newBox.setAttribute("selected", "true");

      newBox.getElementsByTagName("img")[0].src = photo.url;
      photoboxTemplate.parentNode.insertBefore(newBox, photoboxTemplate);
    });
  },
  _photoFromEvent: function(event) {
    event.stopPropagation();
    var node = event.target;
    while (node) {
      if (node.photo)
        return node.photo;
      node = node.parentNode;
    }
    return null;
  },
  selectPhoto: function(event) {
    var photo = this._photoFromEvent(event);
    if (!photo) {
      LOG("Error, photo not found");
      return;
    }
    PhotoSet.selected = photo;
  },
  removePhoto: function(event) {
    var photo = this._photoFromEvent(event);
    if (!photo) {
      LOG("Error, photo not found");
      return;
    }
    PhotoSet.remove(photo);
  }
};

/**
 * The panel that shows the selected photo where attributes can be edited.
 */
var EditPanel = {
  _editImageFrame: null,
  _imageElement: null,
  _highlightDiv: null,

  init: function() {
    PhotoSet.addChangedListener(this.photosChanged, EditPanel);
    this._editImageFrame = document.getElementById("editImageFrame");
    this._imageElement = this._editImageFrame.contentDocument
                             .getElementById("image");
    this._highlightDiv = this._editImageFrame.contentDocument
                             .getElementById("tagHighlight");
  },

  uninit: function() {
    PhotoSet.removeChangedListener(this.photosChanged, EditPanel);
  },

  photosChanged: function() {
    LOG("EditPanel::PhotosChanged");

    var filenameField = document.getElementById("editFilenameField");
    var sizeField = document.getElementById("editSizeField");
    var captionField = document.getElementById("editCaptionField");
    var tagList = document.getElementById("editTagList");
    var tagHelpBox = document.getElementById("editTagHelpBox");
    var removeTagsButton = document.getElementById("editRemoveTagsButton");

    this._imageElement.removeAttribute("hidden");
    this._hideTagHighlight();
    captionField.disabled = false;
    tagHelpBox.collapsed = false;
    removeTagsButton.disabled = true;
    while (tagList.hasChildNodes())
      tagList.removeChild(tagList.firstChild);

    if (!PhotoSet.selected) {
      this._imageElement.setAttribute("hidden", "true");
      filenameField.value = "";
      sizeField.value = "";
      captionField.value = "";
      captionField.disabled = true;
      return;
    }

    var selectedPhoto = PhotoSet.selected;
    this._imageElement.setAttribute("src", selectedPhoto.url);
    var filename = selectedPhoto.filename;
    const MAX_FILENAME_SIZE = 30;
    if (filename.length > MAX_FILENAME_SIZE)
      filename = filename.substring(0, MAX_FILENAME_SIZE) + "...";
    filenameField.value = filename;
    var sizeKb = selectedPhoto.sizeInBytes / 1024;
    sizeField.value = sizeKb.toFixed(0) + " kb";
    captionField.value = selectedPhoto.caption;

    if (selectedPhoto.tags.length == 0)
      return;

    tagHelpBox.collapsed = true;

    for each (let tag in selectedPhoto.tags) {
      var item = document.createElement("listitem");
      item.setAttribute("label", tag.label);
      item.tag = tag;
      tagList.appendChild(item);
    }
  },

  _showTagHighlight: function(tag) {
    var divX = this._imageElement.offsetLeft +
                   (tag.x * this._imageElement.clientWidth / 100);
    var divY = this._imageElement.offsetTop +
                   (tag.y * this._imageElement.clientHeight / 100);

    this._highlightDiv.style.left = divX + "px";
    this._highlightDiv.style.top = divY + "px";
    this._highlightDiv.removeAttribute("hidden");
  },

  _hideTagHighlight: function() {
    this._highlightDiv.setAttribute("hidden", "true");
  },

  _updateRemoveTagsButton: function() {
    var tagList = document.getElementById("editTagList");
    var removeTagsButton = document.getElementById("editRemoveTagsButton");
    removeTagsButton.disabled = !tagList.selectedCount;
  },

  onTagSelect: function(event) {
    var tagList = event.target;
    this._updateRemoveTagsButton();
  },

  onMouseOver: function(event) {
    if (event.target.nodeName != "listitem")
      return;
    var tag = event.target.tag;
    if (!tag)
      return;
    this._showTagHighlight(tag);
  },

  onMouseOut: function(event) {
    this._hideTagHighlight();
  },

  onRemoveSelectedTags: function(event) {
    var tagList = document.getElementById("editTagList");
    var selectedPhoto = PhotoSet.selected;
    if (tagList.selectedCount == 0 || !selectedPhoto)
      return;

    for each (let item in tagList.selectedItems) {
      var tag = item.tag;
      selectedPhoto.removeTag(tag);
    }
    PhotoSet.update(selectedPhoto);

    this._updateRemoveTagsButton();
  },

  onCaptionInput: function(event) {
    var selectedPhoto = PhotoSet.selected;
    if (!selectedPhoto)
      return;

    selectedPhoto.caption = event.target.value;
    PhotoSet.update(selectedPhoto);
  },

  onPhotoClick: function(event) {
    var selectedPhoto = PhotoSet.selected;
    if (!selectedPhoto)
      return;

    var offsetXInImage = event.clientX - this._imageElement.offsetLeft;
    var offsetYInImage = event.clientY - this._imageElement.offsetTop;
    var offsetXPercent = (offsetXInImage / this._imageElement.clientWidth * 100).toFixed(0);
    var offsetYPercent = (offsetYInImage / this._imageElement.clientHeight * 100).toFixed(0);
    offsetXPercent = Math.min(Math.max(offsetXPercent, 0), 100);
    offsetYPercent = Math.min(Math.max(offsetYPercent, 0), 100);

    // temporary tag for showing highlight while the tag editing popup is shown.
    var tempTag = new Tag("tempTag", offsetXPercent, offsetYPercent);
    this._showTagHighlight(tempTag);

    // TODO: custom dialog for entering both text and people tags.
    var tagName = prompt("Enter a tag");
    if (tagName === null)
      return;

    var tag = new TextTag(tagName, offsetXPercent, offsetYPercent);
    selectedPhoto.addTag(tag);
    PhotoSet.update(selectedPhoto);
  }
};

var PhotoDNDObserver = {
  getSupportedFlavours : function () {
    var flavours = new FlavourSet();
    flavours.appendFlavour("text/x-moz-url");
    flavours.appendFlavour("application/x-moz-file",  "nsIFile");
    return flavours;
  },

  _getFileFromDragSession: function (session, position) {
    var fileData = { };
    var ios = Cc["@mozilla.org/network/io-service;1"].
              getService(Ci.nsIIOService);
    // if this fails we do not have valid data to drop
    try {
      var xfer = Cc["@mozilla.org/widget/transferable;1"].
                 createInstance(Ci.nsITransferable);
      xfer.addDataFlavor("text/x-moz-url");
      xfer.addDataFlavor("application/x-moz-file", "nsIFile");
      session.getData(xfer, position);

      var flavour = { }, data = { }, length = { };
      xfer.getAnyTransferData(flavour, data, length);
      var selectedFlavour = this.getSupportedFlavours().flavourTable[flavour.value];
      var xferData = new FlavourData(data.value, length.value, selectedFlavour);

      var fileURL = transferUtils.retrieveURLFromData(xferData.data,
                                                      xferData.flavour.contentType);
      var file = ios.newURI(fileURL, null, null).QueryInterface(Ci.nsIFileURL).file;
    } catch (e) {
      LOG("Exception while getting drag data: " + e);
      return null;
    }
    return file;
  },

  onDrop: function (event, dropdata, session) {
    var count = session.numDropItems;
    var files = [];
    for (var i = 0; i < count; ++i) {
      var file = this._getFileFromDragSession(session, i);
      if (file)
        files.push(file);
    }
    PhotoSet.add([new Photo(f) for each (f in files)]);
  }
};

const NEW_ALBUM = 0;
const EXISTING_ALBUM = 1;

const POST_UPLOAD_ASKUSER = 0;
const POST_UPLOAD_OPENALBUM = 1;
const POST_UPLOAD_STAYHERE = 2;

/**
 * Manages the Photo upload window.
 */
var PhotoUpload = {
  get _stringBundle() {
    delete this._stringBundle;
    return this._stringBundle = document.getElementById("facebookStringBundle");
  },

  _url: function(spec) {
    var ios = Cc["@mozilla.org/network/io-service;1"].
              getService(Ci.nsIIOService);
    return ios.newURI(spec, null, null);
  },

  init: function() {
    OverviewPanel.init();
    EditPanel.init();
    PhotoSet.addChangedListener(this.photosChanged, PhotoUpload);

    var albumsPopup = document.getElementById("albumsPopup");
    var self = this;
    this._getAlbums(function(albums) {

      var lastAlbumId = document.getElementById("albumsList")
                                .getAttribute("lastalbumid");
      var selectedItem;
      for each (var album in albums) {
        var menuitem = document.createElement("menuitem");
        menuitem.setAttribute("label", album.name);
        menuitem.setAttribute("albumid", album.aid);
        if (album.aid == lastAlbumId)
          selectedItem = menuitem;
        LOG("Album name: " + album.name + " album id: " + album.aid);
        albumsPopup.appendChild(menuitem);
      }
      if (selectedItem) {
        var albumsList = document.getElementById("albumsList");
        albumsList.selectedItem = selectedItem;
      }
      self._checkPhotoUploadPermission();
    });

    // XXX debug
    /*
    document.getElementById("reopenButton").hidden = false;
    var file, files = [];
    file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
    file.initWithPath("/home/sypasche/projects/facebook/sample_images/metafont.png");
    //file.initWithPath("/home/sypasche/projects/facebook/sample_images/very_wide.png");
    files.push(file);
    file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
    file.initWithPath("/home/sypasche/projects/facebook/sample_images/recycled.png");
    //file.initWithPath("/home/sypasche/projects/facebook/sample_images/very_tall.png");
    files.push(file);
    file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
    file.initWithPath("/home/sypasche/projects/facebook/sample_images/hot-2560x1280.jpg");
    files.push(file);
    file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
    file.initWithPath("/home/sypasche/projects/facebook/sample_images/strings-dark-1600x1200.jpg");
    files.push(file);
    var photos = [new Photo(f) for each (f in files)];
    LOG("photos " + photos);
    //photos[0].addTextTag("sample text tag 1");
    photos[0].addTag(new TextTag("sample text tag 1", 50, 50));
    //photos[0].addTextTag("sample text tag 2");
    photos[0].addTag(new TextTag("sample text tag 2", 0, 100));
    PhotoSet.add(photos);
    PhotoSet.selected = photos[0];
    */
  },

  uninit: function() {
    OverviewPanel.uninit();
    EditPanel.uninit();
    PhotoSet.removeChangedListener(this.photosChanged, PhotoUpload);
    if (this.getAlbumSelectionMode() == EXISTING_ALBUM) {
      var albumsList = document.getElementById("albumsList");
      var albumId = albumsList.selectedItem.getAttribute("albumid");
      document.getElementById("albumsList").setAttribute("lastalbumid", albumId);
    }
    document.persist("albumsList", "lastalbumid");
  },

  _checkPhotoUploadPermission: function() {
    LOG("Checking photo upload permission");
    const PERM = "photo_upload";

    var self = this;
    // XXX wrappedJSObject hack because the method is not exposed.
    gFacebookService.wrappedJSObject.callMethod('facebook.users.hasAppPermission',
                                                ['ext_perm=' + PERM],
                                                function(data) {
      if ('1' == data.toString()) {
        LOG("photo upload is authorized");
        return;
      }

      let promptTitle = self._stringBundle.getString("allowUploadTitle");
      let promptMessage = self._stringBundle.getString("allowUploadMessage");
      let openAuthorize = self._stringBundle.getString("openAuthorizePage");

      const IPS = Ci.nsIPromptService;
      let ps = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(IPS);
      let rv = ps.confirmEx(window, promptTitle, promptMessage,
                            (IPS.BUTTON_TITLE_IS_STRING * IPS.BUTTON_POS_0) +
                            (IPS.BUTTON_TITLE_CANCEL * IPS.BUTTON_POS_1),
                            openAuthorize, null, null, null, {value: 0});

      if (rv != 0)
        return;
      var authorizeUrl = "http://www.facebook.com/authorize.php?api_key=" +
                         gFacebookService.apiKey +"&v=1.0&ext_perm=" + PERM;
      Application.activeWindow.open(self._url(authorizeUrl)).focus();
      window.close();
    });
  },

  photosChanged: function() {
    document.getElementById("uploadButton").disabled = PhotoSet.photos.length == 0;
  },

  getAlbumSelectionMode: function() {
    var albumSelectionGroup = document.getElementById("albumSelectionGroup");
    var existingAlbumRadio = document.getElementById("existingAlbumRadio");
    var newAlbumRadio = document.getElementById("newAlbumRadio");

    if (albumSelectionGroup.selectedItem == existingAlbumRadio)
      return EXISTING_ALBUM;
    if (albumSelectionGroup.selectedItem == newAlbumRadio)
      return NEW_ALBUM;

    throw "Unknown album selection mode";
  },

  onAlbumSelectionModeChange: function() {
    var albumSelectionDeck = document.getElementById("albumSelectionDeck");
    var selectionMode = this.getAlbumSelectionMode();

    if (selectionMode == EXISTING_ALBUM) {
      albumSelectionDeck.selectedPanel =
        document.getElementById("existingAlbumPanel");
    } else if (selectionMode == NEW_ALBUM) {
      albumSelectionDeck.selectedPanel =
        document.getElementById("newAlbumPanel");
    }
  },

  _getAlbums: function(callback) {
    // XXX wrappedJSObject hack because the method is not exposed.
    gFacebookService.wrappedJSObject.callMethod('facebook.photos.getAlbums',
                                     ["uid=" + gFacebookService.wrappedJSObject._uid],
                                     callback
    );
  },

  addPhotos: function() {
    var fp = Cc["@mozilla.org/filepicker;1"].
             createInstance(Ci.nsIFilePicker);
    fp.init(window, this._stringBundle.getString("filePickerTitle"),
            Ci.nsIFilePicker.modeOpenMultiple);
    fp.appendFilters(Ci.nsIFilePicker.filterImages);
    if (fp.show() != Ci.nsIFilePicker.returnCancel) {
      var photos = [];
      var filesEnum = fp.files;
      while (filesEnum.hasMoreElements()) {
        photos.push(new Photo(filesEnum.getNext()));
      }
      PhotoSet.add(photos);
    }
  },

  removeAllPhotos: function() {
    PhotoSet.removeAll();
  },

  cancelUpload: function() {
    PhotoSet.cancelUpload();
  },

  /**
   * Converts the album id that is used in the Facebook API to the album id
   * that is used in the aid GET parameter of the editalbum.php page.
   */
  _albumIdToUrlAlbumId: function(albumId) {
    // the url album id is the least significant 32 bits of the api-generated
    // album id, the user id is the most significant 32 bits.

    // Javascript Number are 64bit floating point. The albumid is a 64bit integer.
    // That number is too big to be handled directly without loss of precision,
    // so we use an external library for calculation.
    var id = new BigInteger(albumId, 10);
    var mask = new BigInteger("ffffffff", 16);
    var urlAlbumId = id.and(mask);
    return urlAlbumId.toString(10);
  },

  _postUpload: function(albumId) {
    var prefSvc = Cc['@mozilla.org/preferences-service;1'].getService(Ci.nsIPrefBranch);
    var postUploadAction = prefSvc.getIntPref("extensions.facebook.postuploadaction");

    if (postUploadAction == POST_UPLOAD_ASKUSER) {
      let promptTitle = this._stringBundle.getString("uploadCompleteTitle");
      let promptMessage = this._stringBundle.getString("uploadCompleteMessage");
      let checkboxLabel = this._stringBundle.getString("rememberDecision");
      let goToAlbum = this._stringBundle.getString("goToAlbum");
      let stayHere = this._stringBundle.getString("stayHere");

      const IPS = Ci.nsIPromptService;
      let ps = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(IPS);
      let remember = { value: false };
      let rv = ps.confirmEx(window, promptTitle, promptMessage,
                            (IPS.BUTTON_TITLE_IS_STRING * IPS.BUTTON_POS_0) +
                            (IPS.BUTTON_TITLE_IS_STRING * IPS.BUTTON_POS_1),
                            goToAlbum, stayHere, null, checkboxLabel, remember);

      postUploadAction = rv == 0 ? POST_UPLOAD_OPENALBUM : POST_UPLOAD_STAYHERE;
      if (remember.value) {
        prefSvc.setIntPref("extensions.facebook.postuploadaction", postUploadAction);
      }
    }
    if (postUploadAction == POST_UPLOAD_STAYHERE)
      return;

    if (postUploadAction == POST_UPLOAD_OPENALBUM) {
      var aid = "";
      // TODO: what should the URL be in this case?
      if (albumId != DEFAULT_ALBUM)
        aid = "aid=" + this._albumIdToUrlAlbumId(albumId) + "&";
      Application.activeWindow.open(
        this._url("http://www.facebook.com/editalbum.php?" + aid + "org=1")).focus();
      window.close();
    }
  },

  upload: function() {
    if (PhotoSet.photos.length == 0) {
      // This shouldn't happen (button is disabled when there are no photos).
      return;
    }

    var albumId = DEFAULT_ALBUM;
    var selectionMode = this.getAlbumSelectionMode();
    if (selectionMode == NEW_ALBUM) {
      alert("Album creation not yet implemented");
      // TODO
      return;
    } else if (selectionMode == EXISTING_ALBUM) {
      var albumsList = document.getElementById("albumsList");
      albumId = albumsList.selectedItem.getAttribute("albumid");
    } else {
      throw "Unexpected selection mode";
    }

    LOG("album id: " + albumId);

    var uploadStatus = document.getElementById("uploadStatus")
    var uploadStatusDeck = document.getElementById("uploadStatusDeck");
    var progress = document.getElementById("uploadProgress");

    uploadStatusDeck.selectedIndex = 1;
    var uploadBroadcaster = document.getElementById("uploadBroadcaster");
    uploadBroadcaster.setAttribute("disabled", "true");
    uploadStatus.className = "upload-status";
    uploadStatus.value = "";

    function uploadDone() {
      progress.value = 0;
      uploadBroadcaster.setAttribute("disabled", "false");
      uploadStatusDeck.selectedIndex = 0;
    }

    var self = this;
    PhotoSet.upload(albumId,
      function(percent) { // onProgress callback
        LOG("Got progress " + percent);
        progress.value = percent;
      }, function(cancelled) { // onComplete callback
        uploadDone();

        if (cancelled) {
          uploadStatus.value = self._stringBundle.getString("uploadCancelled");
        } else {
          uploadStatus.value = self._stringBundle.getString("uploadComplete");
          self._postUpload(albumId);
        }
      }, function(message, detail) { // onError callback
        uploadDone();
        alert(self._stringBundle.getString("uploadFailedAlert") + " " + message);
        uploadStatus.className += " error";
        uploadStatus.value = self._stringBundle.getString("uploadFailedStatus") +
                             " " + message;
    });
  }
};
