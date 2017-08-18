sinon = require('sinon')
chai = require('chai')
should = chai.should()
modulePath = "../../../../app/js/ProjectManager.js"
SandboxedModule = require('sandboxed-module')
Errors = require "../../../../app/js/Errors.js"

describe "ProjectManager - getProjectDocs", ->
	beforeEach ->
		@ProjectManager = SandboxedModule.require modulePath, requires:
			"./RedisManager": @RedisManager = {}
			"./DocumentManager": @DocumentManager = {}
			"logger-sharelatex": @logger = { log: sinon.stub(), error: sinon.stub() }
			"./Metrics": @Metrics =
				Timer: class Timer
					done: sinon.stub()
		@project_id = "project-id-123"
		@callback = sinon.stub()

	describe "successfully", ->
		beforeEach (done) ->
			@doc_ids = ["doc-id-1", "doc-id-2", "doc-id-3"]
			@doc_versions = [111, 222, 333]
			@doc_lines = [["aaa","aaa"],["bbb","bbb"],["ccc","ccc"]]
			@docs = [
				{_id: @doc_ids[0], lines: @doc_lines[0], v: @doc_versions[0]}
				{_id: @doc_ids[1], lines: @doc_lines[1], v: @doc_versions[1]}
				{_id: @doc_ids[2], lines: @doc_lines[2], v: @doc_versions[2]}
			]
			@RedisManager.checkOrSetProjectState = sinon.stub().callsArgWith(2, null)
			@RedisManager.getDocIdsInProject = sinon.stub().callsArgWith(1, null, @doc_ids)
			@RedisManager.getDocVersion = sinon.stub()
			@RedisManager.getDocVersion.withArgs(@doc_ids[0]).callsArgWith(1, null, @doc_versions[0])
			@RedisManager.getDocVersion.withArgs(@doc_ids[1]).callsArgWith(1, null, @doc_versions[1])
			@RedisManager.getDocVersion.withArgs(@doc_ids[2]).callsArgWith(1, null, @doc_versions[2])
			@RedisManager.getDocLines = sinon.stub()
			@RedisManager.getDocLines.withArgs(@doc_ids[0]).callsArgWith(1, null, @doc_lines[0])
			@RedisManager.getDocLines.withArgs(@doc_ids[1]).callsArgWith(1, null, @doc_lines[1])
			@RedisManager.getDocLines.withArgs(@doc_ids[2]).callsArgWith(1, null, @doc_lines[2])
			@ProjectManager.getProjectDocs @project_id, @projectStateHash, @excludeVersions,  (error, docs) =>
				@callback(error, docs)
				done()

		it "should check the project state", ->
			@RedisManager.checkOrSetProjectState
				.calledWith(@project_id, @projectStateHash)
				.should.equal true

		it "should get the doc ids in the project", ->
			@RedisManager.getDocIdsInProject
				.calledWith(@project_id)
				.should.equal true

		it "should call the callback without error", ->
			@callback.calledWith(null, @docs).should.equal true

		it "should time the execution", ->
			@Metrics.Timer::done.called.should.equal true

	describe "when the state does not match", ->
		beforeEach (done) ->
			@doc_ids = ["doc-id-1", "doc-id-2", "doc-id-3"]
			@RedisManager.checkOrSetProjectState = sinon.stub().callsArgWith(2, null, true)
			@ProjectManager.getProjectDocs @project_id, @projectStateHash, @excludeVersions,  (error, docs) =>
				@callback(error, docs)
				done()

		it "should check the project state", ->
			@RedisManager.checkOrSetProjectState
				.calledWith(@project_id, @projectStateHash)
				.should.equal true

		it "should call the callback with an error", ->
			@callback.calledWith(new Errors.ProjectStateChangedError("project state changed")).should.equal true

		it "should time the execution", ->
			@Metrics.Timer::done.called.should.equal true

	describe "when a doc errors", ->
		beforeEach (done) ->
			@doc_ids = ["doc-id-1", "doc-id-2", "doc-id-3"]
			@RedisManager.checkOrSetProjectState = sinon.stub().callsArgWith(2, null)
			@RedisManager.getDocIdsInProject = sinon.stub().callsArgWith(1, null, @doc_ids)
			@RedisManager.getDocVersion = sinon.stub().callsArgWith(1, null)
			@RedisManager.getDocLines = sinon.stub()
			@RedisManager.getDocLines.withArgs("doc-id-1").callsArgWith(1, null)
			@RedisManager.getDocLines.withArgs("doc-id-2").callsArgWith(1, @error = new Error("oops")) # trigger an error
			@ProjectManager.getProjectDocs @project_id, @projectStateHash, @excludeVersions, (error, docs) =>
				@callback(error)
				done()

		it "should record the error", ->
			@logger.error
				.calledWith(err: @error, project_id: @project_id, doc_id: "doc-id-2", "error getting project doc lines")
				.should.equal true

		it "should call the callback with an error", ->
			@callback.calledWith(new Error("oops")).should.equal true

		it "should time the execution", ->
			@Metrics.Timer::done.called.should.equal true