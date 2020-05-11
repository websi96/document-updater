/* eslint-disable
    camelcase,
    handle-callback-err,
*/
let HttpController
const DocumentManager = require('./DocumentManager')
const HistoryManager = require('./HistoryManager')
const ProjectManager = require('./ProjectManager')
const Errors = require('./Errors')
const logger = require('logger-sharelatex')
const Metrics = require('./Metrics')
const ProjectFlusher = require('./ProjectFlusher')
const DeleteQueueManager = require('./DeleteQueueManager')
const async = require('async')

const TWO_MEGABYTES = 2 * 1024 * 1024

module.exports = HttpController = {
  getDoc(req, res, next) {
    let fromVersion
    const { doc_id } = req.params
    const { project_id } = req.params
    logger.log({ project_id, doc_id }, 'getting doc via http')
    const timer = new Metrics.Timer('http.getDoc')

    if (req.query.fromVersion != null) {
      fromVersion = parseInt(req.query.fromVersion, 10)
    } else {
      fromVersion = -1
    }

    DocumentManager.getDocAndRecentOpsWithLock(
      project_id,
      doc_id,
      fromVersion,
      function (error, lines, version, ops, ranges, pathname) {
        timer.done()
        if (error) {
          return next(error)
        }
        logger.log({ project_id, doc_id }, 'got doc via http')
        if (lines == null || version == null) {
          return next(new Errors.NotFoundError('document not found'))
        }
        res.json({
          id: doc_id,
          lines,
          version,
          ops,
          ranges,
          pathname
        })
      }
    )
  },

  _getTotalSizeOfLines(lines) {
    let size = 0
    for (const line of lines) {
      size += line.length + 1
    }
    return size
  },

  getProjectDocsAndFlushIfOld(req, res, next) {
    const { project_id } = req.params
    const projectStateHash = req.query.state
    // exclude is string of existing docs "id:version,id:version,..."
    const excludeItems =
      req.query.exclude != null ? req.query.exclude.split(',') : []
    logger.log({ project_id, exclude: excludeItems }, 'getting docs via http')
    const timer = new Metrics.Timer('http.getAllDocs')
    const excludeVersions = {}
    for (const item of excludeItems) {
      const [id, version] = item.split(':')
      excludeVersions[id] = version
    }
    logger.log(
      { project_id, projectStateHash, excludeVersions },
      'excluding versions'
    )
    ProjectManager.getProjectDocsAndFlushIfOld(
      project_id,
      projectStateHash,
      excludeVersions,
      function (error, result) {
        timer.done()
        if (error instanceof Errors.ProjectStateChangedError) {
          res.sendStatus(409) // conflict
        } else if (error) {
          next(error)
        } else {
          logger.log(
            {
              project_id,
              result: result.map((doc) => `${doc._id}:${doc.v}`)
            },
            'got docs via http'
          )
          res.send(result)
        }
      }
    )
  },

  clearProjectState(req, res, next) {
    const { project_id } = req.params
    const timer = new Metrics.Timer('http.clearProjectState')
    logger.log({ project_id }, 'clearing project state via http')
    ProjectManager.clearProjectState(project_id, function (error) {
      timer.done()
      if (error) {
        next(error)
      } else {
        res.sendStatus(200)
      }
    })
  },

  setDoc(req, res, next) {
    const { doc_id } = req.params
    const { project_id } = req.params
    const { lines, source, user_id, undoing } = req.body
    const lineSize = HttpController._getTotalSizeOfLines(lines)
    if (lineSize > TWO_MEGABYTES) {
      logger.log(
        { project_id, doc_id, source, lineSize, user_id },
        'document too large, returning 406 response'
      )
      return res.sendStatus(406)
    }
    logger.log(
      { project_id, doc_id, lines, source, user_id, undoing },
      'setting doc via http'
    )
    const timer = new Metrics.Timer('http.setDoc')
    DocumentManager.setDocWithLock(
      project_id,
      doc_id,
      lines,
      source,
      user_id,
      undoing,
      function (error) {
        timer.done()
        if (error) {
          return next(error)
        }
        logger.log({ project_id, doc_id }, 'set doc via http')
        res.sendStatus(204)
      }
    )
  }, // No Content

  flushDocIfLoaded(req, res, next) {
    const { doc_id } = req.params
    const { project_id } = req.params
    logger.log({ project_id, doc_id }, 'flushing doc via http')
    const timer = new Metrics.Timer('http.flushDoc')
    DocumentManager.flushDocIfLoadedWithLock(project_id, doc_id, function (
      error
    ) {
      timer.done()
      if (error) {
        return next(error)
      }
      logger.log({ project_id, doc_id }, 'flushed doc via http')
      res.sendStatus(204)
    })
  }, // No Content

  deleteDoc(req, res, next) {
    const { doc_id } = req.params
    const { project_id } = req.params
    const ignoreFlushErrors = req.query.ignore_flush_errors === 'true'
    const timer = new Metrics.Timer('http.deleteDoc')
    logger.log({ project_id, doc_id }, 'deleting doc via http')
    DocumentManager.flushAndDeleteDocWithLock(
      project_id,
      doc_id,
      { ignoreFlushErrors },
      function (error) {
        timer.done()
        // There is no harm in flushing project history if the previous call
        // failed and sometimes it is required
        HistoryManager.flushProjectChangesAsync(project_id)

        if (error) {
          return next(error)
        }
        logger.log({ project_id, doc_id }, 'deleted doc via http')
        res.sendStatus(204)
      }
    )
  }, // No Content

  flushProject(req, res, next) {
    const { project_id } = req.params
    logger.log({ project_id }, 'flushing project via http')
    const timer = new Metrics.Timer('http.flushProject')
    ProjectManager.flushProjectWithLocks(project_id, function (error) {
      timer.done()
      if (error) {
        return next(error)
      }
      logger.log({ project_id }, 'flushed project via http')
      res.sendStatus(204)
    })
  }, // No Content

  deleteProject(req, res, next) {
    const { project_id } = req.params
    logger.log({ project_id }, 'deleting project via http')
    const options = {}
    if (req.query.background) {
      options.background = true
    } // allow non-urgent flushes to be queued
    if (req.query.shutdown) {
      options.skip_history_flush = true
    } // don't flush history when realtime shuts down
    if (req.query.background) {
      ProjectManager.queueFlushAndDeleteProject(project_id, function (error) {
        if (error) {
          return next(error)
        }
        logger.log({ project_id }, 'queue delete of project via http')
        res.sendStatus(204)
      }) // No Content
    } else {
      const timer = new Metrics.Timer('http.deleteProject')
      ProjectManager.flushAndDeleteProjectWithLocks(
        project_id,
        options,
        function (error) {
          timer.done()
          if (error) {
            return next(error)
          }
          logger.log({ project_id }, 'deleted project via http')
          res.sendStatus(204)
        }
      )
    }
  }, // No Content

  deleteMultipleProjects(req, res, next) {
    const project_ids = req.body.project_ids || []
    logger.log({ project_ids }, 'deleting multiple projects via http')
    async.eachSeries(
      project_ids,
      function (project_id, cb) {
        logger.log({ project_id }, 'queue delete of project via http')
        ProjectManager.queueFlushAndDeleteProject(project_id, cb)
      },
      function (error) {
        if (error) {
          return next(error)
        }
        res.sendStatus(204)
      }
    )
  }, // No Content

  acceptChanges(req, res, next) {
    const { project_id, doc_id } = req.params
    let change_ids = req.body.change_ids
    if (change_ids == null) {
      change_ids = [req.params.change_id]
    }
    logger.log(
      { project_id, doc_id },
      `accepting ${change_ids.length} changes via http`
    )
    const timer = new Metrics.Timer('http.acceptChanges')
    DocumentManager.acceptChangesWithLock(
      project_id,
      doc_id,
      change_ids,
      function (error) {
        timer.done()
        if (error) {
          return next(error)
        }
        logger.log(
          { project_id, doc_id },
          `accepted ${change_ids.length} changes via http`
        )
        res.sendStatus(204)
      }
    )
  }, // No Content

  deleteComment(req, res, next) {
    const { project_id, doc_id, comment_id } = req.params
    logger.log({ project_id, doc_id, comment_id }, 'deleting comment via http')
    const timer = new Metrics.Timer('http.deleteComment')
    DocumentManager.deleteCommentWithLock(
      project_id,
      doc_id,
      comment_id,
      function (error) {
        timer.done()
        if (error) {
          return next(error)
        }
        logger.log(
          { project_id, doc_id, comment_id },
          'deleted comment via http'
        )
        res.sendStatus(204)
      }
    )
  }, // No Content

  updateProject(req, res, next) {
    const timer = new Metrics.Timer('http.updateProject')
    const { project_id } = req.params
    const {
      projectHistoryId,
      userId,
      docUpdates,
      fileUpdates,
      version
    } = req.body
    logger.log(
      { project_id, docUpdates, fileUpdates, version },
      'updating project via http'
    )

    ProjectManager.updateProjectWithLocks(
      project_id,
      projectHistoryId,
      userId,
      docUpdates,
      fileUpdates,
      version,
      function (error) {
        timer.done()
        if (error) {
          return next(error)
        }
        logger.log({ project_id }, 'updated project via http')
        res.sendStatus(204)
      }
    )
  }, // No Content

  resyncProjectHistory(req, res, next) {
    const { project_id } = req.params
    const { projectHistoryId, docs, files } = req.body

    logger.log(
      { project_id, docs, files },
      'queuing project history resync via http'
    )
    HistoryManager.resyncProjectHistory(
      project_id,
      projectHistoryId,
      docs,
      files,
      function (error) {
        if (error) {
          return next(error)
        }
        logger.log({ project_id }, 'queued project history resync via http')
        res.sendStatus(204)
      }
    )
  },

  flushAllProjects(req, res, next) {
    res.setTimeout(5 * 60 * 1000)
    const options = {
      limit: req.query.limit || 1000,
      concurrency: req.query.concurrency || 5,
      dryRun: req.query.dryRun || false
    }
    ProjectFlusher.flushAllProjects(options, function (err, project_ids) {
      if (err) {
        logger.err({ err }, 'error bulk flushing projects')
        res.sendStatus(500)
      } else {
        res.send(project_ids)
      }
    })
  },

  flushQueuedProjects(req, res, next) {
    res.setTimeout(10 * 60 * 1000)
    const options = {
      limit: req.query.limit || 1000,
      timeout: 5 * 60 * 1000,
      min_delete_age: req.query.min_delete_age || 5 * 60 * 1000
    }
    DeleteQueueManager.flushAndDeleteOldProjects(options, function (
      err,
      flushed
    ) {
      if (err) {
        logger.err({ err }, 'error flushing old projects')
        res.sendStatus(500)
      } else {
        logger.log({ flushed }, 'flush of queued projects completed')
        res.send({ flushed })
      }
    })
  }
}
