-- /transmit ------------------------------------------------------------------
--
-- The client writes SavedVariables on a UI reload and on logout, not during
-- play, so /transmit reloads the UI. The reload fires PLAYER_LOGOUT, where
-- Collect.lua collects every part and writes OpenGamerMCPDB. /transmit
-- changes nothing in the game, and it is the adapter's only command
-- (docs/architecture.md §1, §6.3).
--
-- C_UI.Reload needs a hardware event (warcraft.wiki.gg, API C_UI.Reload). A
-- slash command runs inside one, and a timer callback does not, so the reload
-- is called directly from the handler and never deferred. The documentation
-- lists no combat restriction.

local _, ns = ...

local SafeMessage = ns.SafeMessage
local Lookup = ns.Lookup

-- A blocked reload raises no error, so a timer reports a reload that did not
-- happen. A reload that happens discards the timer.
local TRANSMIT_RELOAD_TIMEOUT = 3

local function Print(text)
	DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99Open Gamer MCP|r " .. text)
end

-- ReloadFunction returns ReloadUI, else C_UI.Reload, whichever the client has.
local function ReloadFunction()
	local reload = Lookup("ReloadUI")
	if type(reload) == "function" then
		return reload
	end
	reload = Lookup("C_UI.Reload")
	if type(reload) == "function" then
		return reload
	end
	return nil
end

-- Transmit returns true when it called the reload.
local function Transmit()
	local reload = ReloadFunction()
	if not reload then
		Print("transmit FAILED: this client has no reload function.")
		return false
	end
	local ok, err = pcall(reload)
	if not ok then
		Print("transmit FAILED: reload: " .. SafeMessage(err))
		return false
	end
	C_Timer.After(TRANSMIT_RELOAD_TIMEOUT, function()
		Print("transmit: the client did not reload. Type /reload to save your state.")
	end)
	return true
end

SLASH_OPENGAMERMCPTRANSMIT1 = "/transmit"
SlashCmdList.OPENGAMERMCPTRANSMIT = function()
	Transmit()
end
