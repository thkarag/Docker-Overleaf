const { callbackify } = require('util')
const _ = require('underscore')
const fsPromises = require('fs/promises')
const logger = require('@overleaf/logger')
const EditorController = require('../Editor/EditorController')
const FileTypeManager = require('../Uploads/FileTypeManager')
const FileWriter = require('../../infrastructure/FileWriter')
const ProjectEntityHandler = require('../Project/ProjectEntityHandler')

async function mergeUpdate(userId, projectId, path, updateRequest, source) {
  const fsPath = await FileWriter.promises.writeStreamToDisk(
    projectId,
    updateRequest
  )
  try {
    const metadata = await _mergeUpdate(userId, projectId, path, fsPath, source)
    return metadata
  } finally {
    try {
      await fsPromises.unlink(fsPath)
    } catch (err) {
      logger.err({ projectId, fsPath }, 'error deleting file')
    }
  }
}

async function _findExistingFileType(projectId, path) {
  const { docs, files } = await ProjectEntityHandler.promises.getAllEntities(
    projectId
  )
  if (_.some(docs, d => d.path === path)) {
    return 'doc'
  }
  if (_.some(files, f => f.path === path)) {
    return 'file'
  }
  return null
}

async function _determineFileType(projectId, path, fsPath) {
  // check if there is an existing file with the same path (we either need
  // to overwrite it or delete it)
  const existingFileType = await _findExistingFileType(projectId, path)

  // determine whether the update should create a doc or binary file
  const { binary, encoding } = await FileTypeManager.promises.getType(
    path,
    fsPath,
    existingFileType
  )

  // If we receive a non-utf8 encoding, we won't be able to keep things in
  // sync, so we'll treat non-utf8 files as binary
  const isBinary = binary || encoding !== 'utf-8'

  // Existing | Update    | Resulting file type
  // ---------|-----------|--------------------
  // file     | isBinary  | file
  // file     | !isBinary | file
  // doc      | isBinary  | file
  // doc      | !isBinary | doc
  // null     | isBinary  | file
  // null     | !isBinary | doc

  // if a binary file already exists, always keep it as a binary file
  // even if the update looks like a text file
  if (existingFileType === 'file') {
    return 'file'
  } else {
    return isBinary ? 'file' : 'doc'
  }
}

async function _mergeUpdate(userId, projectId, path, fsPath, source) {
  const fileType = await _determineFileType(projectId, path, fsPath)

  if (fileType === 'file') {
    const { file, folder } = await _processFile(
      projectId,
      fsPath,
      path,
      source,
      userId
    )
    return {
      entityType: 'file',
      entityId: file._id,
      rev: file.rev,
      folderId: folder._id,
    }
  } else if (fileType === 'doc') {
    const { doc, folder } = await _processDoc(
      projectId,
      userId,
      fsPath,
      path,
      source
    )
    return {
      entityType: 'doc',
      entityId: doc._id,
      rev: doc.rev,
      folderId: folder._id,
    }
  } else {
    throw new Error('unrecognized file')
  }
}

async function deleteUpdate(userId, projectId, path, source) {
  try {
    await EditorController.promises.deleteEntityWithPath(
      projectId,
      path,
      source,
      userId
    )
  } catch (err) {
    logger.warn(
      { err, userId, projectId, path, source },
      'failed to delete entity'
    )
  }
}

async function _processDoc(projectId, userId, fsPath, path, source) {
  const docLines = await _readFileIntoTextArray(fsPath)
  logger.debug({ docLines }, 'processing doc update from tpds')
  const doc = await EditorController.promises.upsertDocWithPath(
    projectId,
    path,
    docLines,
    source,
    userId
  )
  return doc
}

async function _processFile(projectId, fsPath, path, source, userId) {
  const { file, folder } = await EditorController.promises.upsertFileWithPath(
    projectId,
    path,
    fsPath,
    null,
    source,
    userId
  )
  return { file, folder }
}

async function _readFileIntoTextArray(path) {
  let content = await fsPromises.readFile(path, 'utf8')
  if (content == null) {
    content = ''
  }
  const lines = content.split(/\r\n|\n|\r/)
  return lines
}

module.exports = {
  mergeUpdate: callbackify(mergeUpdate),
  _mergeUpdate: callbackify(_mergeUpdate),
  deleteUpdate: callbackify(deleteUpdate),
  promises: {
    mergeUpdate,
    _mergeUpdate, // called by GitBridgeHandler
    deleteUpdate,
  },
}
