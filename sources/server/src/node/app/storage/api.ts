/*
 * Copyright 2015 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */


/// <reference path="../../../../../../externs/ts/node/node.d.ts" />
/// <reference path="../../../../../../externs/ts/express/express.d.ts" />
/// <reference path="../shared/requests.d.ts" />
/// <reference path="../common/interfaces.d.ts" />
import apiutil = require('../common/api');
import content = require('./content');
import express = require('express');
import logging = require('../common/logging');
import nbstorage = require('../notebooks/storage');

var logger = logging.getLogger();

/**
 * Content management HTTP API.
 */
export class ContentApi {

  _notebookStorage: app.INotebookStorage;
  _storage: app.IStorage;

  /**
   * Constructor.
   *
   * @param storage The storage backend to use for accessing and manipulating content.
   */
  constructor (storage: app.IStorage) {
    // Create a notebook storage wrapper for handling notebook-specific storage operations.
    this._notebookStorage = new nbstorage.NotebookStorage(storage);
    this._storage = storage;
  }

  /**
   * Creates a file at the path specified by the request.
   *
   * TODO(bryantd): support directory creation.
   *
   * @param request HTTP request object.
   * @param response HTTP response object.
   */
  create(request: express.Request, response: express.Response): void {
    var path = this._getPathOrFail(request, response);
    if (!path) {
      // Response has been handled by getPathOrFail.
      return;
    }

    // Get the request body, which defines what content should be created at the specified path.
    var body: app.requests.CreateContentRequestBody = request.body;

    var callback = (createdPath: string, error: Error) => {
      if (error) {
        apiutil.sendInternalError(response, "Content create operation failed.", error);
      } else {
        response.send({createdPath: createdPath});
      }
    };

    // Select the appropriate content creation scheme depending on the request body content.
    if (body.content) {
      // Then we'll be creating a new file from this specified content.
      this._storage.write(path, body.content, callback.bind(null, path));
    } else {
      // The only file extension with a declared default template is ".ipynb".
      var notebookExtension = '.ipynb';
      if (!content.endsWith(path, notebookExtension)) {
        // If the path is extension-less, then append ".ipynb" and proceed.
        if (content.getExtension(path) == null) {
          path = path + notebookExtension;
        } else {
          // Any other extension is currently disallowed, so fail the request.
          apiutil.sendBadRequest(response,
            'Content creation for non-ipynb files requires content specification');
          return;
        }
      }

      logger.debug('Creating notebook with path "%s"', path);
      // If no body was sent, then select an appropriate template based upon the file extension.
      this._notebookStorage.create(path, callback.bind(null, path));
    }
  }

  /**
   * Deletes a file at the specified path.
   *
   * TODO(bryantd): support directory deletion with emptiness precondition.
   *
   * @param request HTTP request object.
   * @param response HTTP response object.
   */
  delete(request: express.Request, response: express.Response): void {
    var path = this._getPathOrFail(request, response);
    if (!path) {
      // Response has been handled by getPathOrFail.
      return;
    }

    this._storage.delete(path, (error) => {
      if (error) {
        apiutil.sendInternalError(response, "Content delete operation failed.", error);
        return;
      }

      apiutil.sendSuccessWithoutResponseContent(response);
    });
  }

  /**
   * Enumerates the resources that match the given path prefix.
   *
   * @param request HTTP request object.
   * @param response HTTP response object.
   */
  list(request: express.Request, response: express.Response): void {
    // Normalize the requested storage directory path to list.
    var storageDirectoryPath = content.normalizeDirectoryPath(request.param('0', undefined));

    // Get the recursive flag from the request if it was provided and convert it to a boolean.
    // Any truthy string value will be converted to true, so all of the following would
    // enable recursive==true:
    //
    // ?recursive=true
    // ?recursive=1
    //
    // To make the flag false, it can just be omitted from the query params, or an empty string
    // passed as it's value.
    var isRecursive = !!request.query.recursive;

    // Asynchronously list the resources that exist at the given path prefix within storage.
    this._storage.list(
        storageDirectoryPath,
        isRecursive,
        (error: Error, resources: app.Resource[]) => {

      if (error) {
        apiutil.sendInternalError(response, "Content list operation failed.", error);
        return;
      }

      // Success. Send the list of resources matching the specified path prefix.
      response.send({
        prefix: storageDirectoryPath,
        resources: resources
      });
    });
  }

  /**
   * Moves the file at the request path to the new path specified in the request body.
   *
   * TODO(bryantd): support directory renaming.
   *
   * @param request HTTP request object.
   * @param response HTTP response object.
   */
  move(request: express.Request, response: express.Response): void {
    var path = this._getPathOrFail(request, response);
    if (!path) {
      // Response has been handled by getPathOrFail.
      return;
    }

    var body: app.requests.MoveContentRequestBody = request.body;
    var newPath = body.path;

    this._storage.move(path, newPath, (error) => {
      if (error) {
        apiutil.sendInternalError(response, "Content move operation failed.", error);
        return;
      }
      apiutil.sendSuccessWithoutResponseContent(response);
    });
  }

  /**
   * Updates the content at the request path with the request body content.
   *
   * @param request HTTP request object.
   * @param response HTTP response object.
   */
  update(request: express.Request, response: express.Response): void {
    var path = this._getPathOrFail(request, response);
    if (!path) {
      // Response has been handled by getPathOrFail.
      return;
    }

    // Get the updated content from the body of the request.
    var body: app.requests.CreateContentRequestBody = request.body;

    // Select the appropriate content creation scheme depending on the request body content.
    if (!body.content) {
      apiutil.sendBadRequest(response, 'Missing content field from request body.');
      return;
    }

    // Asynchronously write the content to the given path in storage.
    this._storage.write(path, body.content, (error) => {
      if (error) {
        apiutil.sendInternalError(response, "Content update operation failed.", error);
        return;
      }

      apiutil.sendSuccessWithoutResponseContent(response);
    });
  }

  /**
   * Registers routes for the resources API.
   *
   * @param route The express router that will manage request routing for this API.
   */
  register(router: express.Router): void {
    // Allow GET on the /content route (i.e., list operation on storage root).
    router.get(/^\/content\/?$/, this.list.bind(this));
    // Allow GET on the /content/<path> route.
    router.get(/^\/content\/([^:]+)$/, this.list.bind(this));

    router.post(/^\/content\/([^:]+):move$/, this.move.bind(this));
    router.put(/^\/content\/([^:]+)$/, this.update.bind(this));
    router.post(/^\/content\/([^:]+)$/, this.create.bind(this));
    router.delete(/^\/content\/([^:]+)$/, this.delete.bind(this));
  }

  /**
   * Gets the resource path from the request or fails the request (via response object).
   *
   * If a path is not specified by the request, then the request is considered malformed
   * and a HTTP 400 status (Bad Request) is sent to the caller.
   *
   * @param request HTTP request object.
   * @param response HTTP response object.
   */
  _getPathOrFail(request: express.Request, response: express.Response): string {
    var path: string = request.param('0', null);
    if (!path) {
      apiutil.sendBadRequest(response, "Content 'path' missing from request URL.");
    }
    return content.ensureLeadingSlash(path);
  }

}
