--[[
	MAPLE Lua Heartbeat Example:
	- Automatically communicates with the MAPLE local backend on your device to manage your Roblox instance.
	
	API:
	- `Heartbeat.Start(Interval)` : Starts the healthcheck loop and error prompt listeners.
	  (Optional) `Interval` defaults to 60 seconds.
	- `Heartbeat.Stop()` : Safely disconnects all listeners, stops threads, and resets state.
	- `Heartbeat.CleanupState()` : Internal method to force cleanup of connections and threads.
	
	Implementation:
	-- 1. Load and Start
    ```lua
	pcall(function()
		getgenv().HeartbeatModule = loadstring(game:HttpGet("RAW_SCRIPT_URL"))()
		getgenv().HeartbeatModule.Start(60)
	end)
    ```

	-- 2. Cleanup & Stop
    ```lua
	if type(getgenv().HeartbeatModule) == "table" then
		pcall(getgenv().HeartbeatModule.Stop)
		getgenv().HeartbeatModule = nil
	end
    ```
]]

local HttpService = game:GetService("HttpService")
local CoreGui = game:GetService("CoreGui")
local TeleportService = game:GetService("TeleportService")

local HttpRequest = request or http_request or (http and http.request) or syn and syn.request
if not HttpRequest then
	warn("HEARTBEAT ERROR: Failed to execute heartbeat. HttpRequest is not available. Please ensure your executor has support for HttpRequest and try again.")
	return {}
end

local LPH_NO_VIRTUALIZE = LPH_NO_VIRTUALIZE or function(Function)
	return Function
end

local Heartbeat = {
	IsRunning = false,
	HealthcheckThread = nil,
	HasFiredEndpoint = false,
	HealthcheckInterval = 60,
	Connections = {},

	Endpoints = {
        Start = "http://127.0.0.1:3000/api/start",
		Healthcheck = "http://127.0.0.1:3000/api/healthcheck",
		Relaunch = "http://127.0.0.1:3000/api/relaunch",
		Cycle = "http://127.0.0.1:3000/api/cycle",
		Kill = "http://127.0.0.1:3000/api/kill"
	},

	-- Dictionary keyed by error code for O(1) lookup
	-- Each entry maps to { Endpoint, MatchText }
	ErrorCases = {
		-- Kill Cases
		["268"] = { Endpoint = "Kill", MatchText = "You have been kicked due to unexpected client behavior." },
		["272"] = { Endpoint = "Kill", MatchText = "Disconnected due to Security Key Mismatch." },
		["275"] = { Endpoint = "Kill", MatchText = "Roblox is down for maintenance. Please try again later." },

		-- Cycle Cases
		["256"] = { Endpoint = "Cycle", MatchText = "Developer has shut down all game servers." },
		["267"] = { Endpoint = "Cycle", MatchText = "You were kicked from this experience:" },
		["524"] = { Endpoint = "Cycle", MatchText = "Not authorized to join this experience." },
		["773"] = { Endpoint = "Cycle", MatchText = "Teleport failed: Game is restricted." },

		-- Relaunch Cases
		["264"] = { Endpoint = "Relaunch", MatchText = "Same account launched experience from different device." },
		["273"] = { Endpoint = "Relaunch", MatchText = "Disconnected from game, possibly due to game joined from another device." },
		["278"] = { Endpoint = "Relaunch", MatchText = "You were disconnected for being idle 20 minutes." },
		["286"] = { Endpoint = "Relaunch", MatchText = "Your device does not have enough memory to run this experience. Exit to the home screen." },
		["260"] = { Endpoint = "Relaunch", MatchText = "There was a problem receiving data, please reconnect." },
		["261"] = { Endpoint = "Relaunch", MatchText = "There was a problem streaming data, please reconnect." },
		["262"] = { Endpoint = "Relaunch", MatchText = "There was a problem sending data, please reconnect." },
		["277"] = { Endpoint = "Relaunch", MatchText = "Please check your internet connection and try again." },
		["279"] = { Endpoint = "Relaunch", MatchText = "Connection Failed. Failed to connect to the experience. No response from server." },
		["271"] = { Endpoint = "Relaunch", MatchText = "Server was shutdown due to no active players." },
		["529"] = { Endpoint = "Relaunch", MatchText = "We are experiencing technical difficulties. Please try again later." },
		["772"] = { Endpoint = "Relaunch", MatchText = "Teleport failed: Server is full." },
		["610"] = { Endpoint = "Relaunch", MatchText = "Can't join place" },
		["523"] = { Endpoint = "Relaunch", MatchText = "The status of the experience has changed and you can no longer join." },
		["274"] = { Endpoint = "Relaunch", MatchText = "The experience developer has shut down this server." }
	}
}

---Registers a connection to be cleaned up when the module stops.
---@param Connection RBXScriptConnection
function Heartbeat.RegisterConnection(Connection)
	if Connection then
		table.insert(Heartbeat.Connections, Connection)
	end
end

---Disconnects all registered connections and clears the connection array.
function Heartbeat.DisconnectAllConnections()
	for ConnectionIndex = 1, #Heartbeat.Connections do
		local Connection = Heartbeat.Connections[ConnectionIndex]
		if Connection and Connection.Disconnect then
			pcall(Connection.Disconnect, Connection)
		end
	end
	table.clear(Heartbeat.Connections)
end

---Cancels the healthcheck thread if it is running.
function Heartbeat.StopHealthcheckThread()
	if Heartbeat.HealthcheckThread then
		task.cancel(Heartbeat.HealthcheckThread)
		Heartbeat.HealthcheckThread = nil
	end
end

---Cleans up the module state, stopping threads and disconnecting listeners.
---@return boolean
function Heartbeat.CleanupState()
	Heartbeat.DisconnectAllConnections()
	Heartbeat.StopHealthcheckThread()
	Heartbeat.IsRunning = false
	return true
end

---Sends an HTTP request to the MAPLE backend endpoint.
---@param EndpointUrl string
---@param Reason string
function Heartbeat.SendEndpointRequest(EndpointUrl, Reason)
	if Heartbeat.HasFiredEndpoint then
		return
	end

	Heartbeat.HasFiredEndpoint = true

	pcall(function()
		HttpRequest({
			Url = EndpointUrl,
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json"
			},
			Body = HttpService:JSONEncode({ reason = Reason })
		})
	end)

	Heartbeat.CleanupState()
end

---Processes the extracted text from a Roblox ErrorPrompt, matches it against known cases,
---and fires the corresponding API endpoint.
---@param PromptText string
function Heartbeat.ProcessDisconnectMessage(PromptText)
	local ErrorCode = string.match(PromptText, "Error Code:%s*(%d+)")
	if not ErrorCode then
		Heartbeat.SendEndpointRequest(Heartbeat.Endpoints.Relaunch, "Unknown ErrorPrompt: " .. PromptText)
		return
	end

	local CaseData = Heartbeat.ErrorCases[ErrorCode]
	if CaseData and string.find(PromptText, CaseData.MatchText, 1, true) then
		Heartbeat.SendEndpointRequest(Heartbeat.Endpoints[CaseData.Endpoint], CaseData.Endpoint .. " Case Matched: " .. ErrorCode)
		return
	end

	Heartbeat.SendEndpointRequest(Heartbeat.Endpoints.Relaunch, "Unrecognized Error Code: " .. ErrorCode)
end

---Starts the healthcheck loop that continuously pings the backend.
function Heartbeat.StartHealthcheckLoop()
	Heartbeat.HealthcheckThread = task.spawn(function()
		while true do
			pcall(function()
				HttpRequest({
					Url = Heartbeat.Endpoints.Healthcheck,
					Method = "POST",
					Headers = {
						["Content-Type"] = "application/json"
					}
				})
			end)
			task.wait(Heartbeat.HealthcheckInterval)
		end
	end)
end

---Extracts and concatenates all text from a suspected ErrorPrompt instance.
---@param Target Instance
function Heartbeat.CheckForErrorPrompt(Target)
	if not Heartbeat.IsRunning then
		return
	end

	local PromptOverlay = Target.Parent
	if not PromptOverlay or PromptOverlay.Name ~= "promptOverlay" then
		return
	end

	local RobloxPromptGui = PromptOverlay.Parent
	if not RobloxPromptGui or RobloxPromptGui.Name ~= "RobloxPromptGui" then
		return
	end

	local TextParts = {}
	for _, Child in ipairs(Target:GetDescendants()) do
		if Child:IsA("TextLabel") and Child.Text ~= "" then
			TextParts[#TextParts + 1] = Child.Text
		end
	end

	if #TextParts > 0 then
		Heartbeat.ProcessDisconnectMessage(table.concat(TextParts, " "))
	end
end

---Connects CoreGui and TeleportService listeners to detect game disconnects.
function Heartbeat.StartErrorListeners()
	local DescendantAddedConnection = CoreGui.DescendantAdded:Connect(LPH_NO_VIRTUALIZE(function(Descendant)
		if Heartbeat.HasFiredEndpoint then
			return
		end

		if Descendant.Name == "ErrorPrompt" then
			task.defer(function()
				Heartbeat.CheckForErrorPrompt(Descendant)
			end)
		elseif Descendant:IsA("TextLabel") then
			local Current = Descendant.Parent
			while Current and Current ~= game do
				if Current.Name == "ErrorPrompt" then
					task.defer(function()
						Heartbeat.CheckForErrorPrompt(Current)
					end)
					break
				end
				Current = Current.Parent
			end
		end
	end))

	Heartbeat.RegisterConnection(DescendantAddedConnection)

	local TeleportFailedConnection = TeleportService.TeleportInitFailed:Connect(LPH_NO_VIRTUALIZE(function(Player, TeleportResult, ErrorMessage)
		Heartbeat.SendEndpointRequest(Heartbeat.Endpoints.Relaunch, "TeleportInitFailed: " .. tostring(ErrorMessage))
	end))

	Heartbeat.RegisterConnection(TeleportFailedConnection)
end

---Starts the heartbeat module, healthcheck thread, and error listeners.
---@param Interval number?
---@return boolean, string?
function Heartbeat.Start(Interval)
	if Heartbeat.IsRunning then
		return false, "Heartbeat is already running."
	end

	Heartbeat.IsRunning = true
	Heartbeat.HasFiredEndpoint = false

	if type(Interval) == "number" then
		Heartbeat.HealthcheckInterval = Interval
	end

	Heartbeat.StartHealthcheckLoop()
	Heartbeat.StartErrorListeners()

	return true
end

---Safely stops the heartbeat module and cleans up all state.
---@return boolean, string?
function Heartbeat.Stop()
	if not Heartbeat.IsRunning then
		return false, "Heartbeat is not running."
	end

	local DidCleanup, CleanupResult = pcall(Heartbeat.CleanupState)
	if not DidCleanup then
		return false, CleanupResult
	end

	Heartbeat.HasFiredEndpoint = false
	return true
end

return Heartbeat