local resource = GetCurrentResourceName()
local prefix = resource .. ':mcp:lua:'
local active = {}
local MAX_LOGS = 100
local MAX_RESULT = 131072

local function arrayJson(values, count)
    local parts = {}
    for i = 1, count or #values do
        parts[i] = json.encode(values[i])
    end
    return '[' .. table.concat(parts, ',') .. ']'
end

local function sanitize(value, depth, seen, budget)
    budget = budget or { remaining = 1000 }
    budget.remaining = budget.remaining - 1
    if budget.remaining < 0 then return { ['$type'] = 'max-items' } end
    local kind = type(value)
    if kind == 'nil' then return { ['$type'] = 'nil' } end
    if kind == 'string' then return #value > 8192 and value:sub(1, 8192) .. '[truncated]' or value end
    if kind == 'boolean' then return value end
    if kind == 'number' then
        if value ~= value or value == math.huge or value == -math.huge then
            return { ['$type'] = 'number', value = tostring(value) }
        end
        return value
    end
    if kind == 'vector2' or kind == 'vector3' or kind == 'vector4' then
        local vector = { ['$type'] = kind, x = value.x, y = value.y }
        if kind ~= 'vector2' then vector.z = value.z end
        if kind == 'vector4' then vector.w = value.w end
        return vector
    end
    if kind ~= 'table' then return { ['$type'] = kind } end
    if seen[value] then return { ['$type'] = 'circular' } end
    if depth >= 6 then return { ['$type'] = 'max-depth' } end
    seen[value] = true
    local result, entries, count, stringKeys = {}, {}, 0, true
    for key, item in next, value do
        count = count + 1
        if count > 100 then
            result['$truncated'] = true
            break
        end
        local safe = sanitize(item, depth + 1, seen, budget)
        if type(key) == 'string' then
            result[key:sub(1, 256)] = safe
        else
            stringKeys = false
        end
        entries[#entries + 1] = { key = sanitize(key, depth + 1, seen, budget), value = safe }
    end
    seen[value] = nil
    if stringKeys then return result end
    return { ['$type'] = 'table', entries = entries, truncated = count > 100 }
end

local function failure(id, message)
    TriggerEvent(prefix .. 'result', id, json.encode({
        ok = false, error = tostring(message):sub(1, 8192), durationMs = 0
    }):sub(1, -2) .. ',"values":[],"logs":[]}')
end

AddEventHandler(prefix .. 'execute', function(raw)
    if type(raw) ~= 'string' or #raw > 270000 then
        print('[dolu_fivem_mcp] Rejected invalid Lua execution envelope')
        return
    end
    local decoded, request = pcall(json.decode, raw)
    if not decoded or type(request) ~= 'table' or type(request.id) ~= 'string'
        or type(request.code) ~= 'string' or #request.code > 65536
        or type(request.timeoutMs) ~= 'number' or request.timeoutMs < 100 or request.timeoutMs > 60000 then
        print('[dolu_fivem_mcp] Rejected malformed Lua execution request')
        return
    end
    if active[request.id] then
        failure(request.id, 'Duplicate execution id')
        return
    end
    local state = { alive = true }
    active[request.id] = state
    CreateThread(function()
        local start = GetGameTimer()
        local logs, cleanups = {}, {}
        local function log(...)
            if not state.alive or #logs >= MAX_LOGS then return end
            local values = table.pack(...)
            local parts = {}
            for i = 1, values.n do
                parts[i] = type(values[i]) == 'string' and values[i] or json.encode(sanitize(values[i], 0, {}))
            end
            local message = table.concat(parts, ' '):sub(1, 4096)
            logs[#logs + 1] = { level = 'info', message = message }
            TriggerEvent(prefix .. 'log', json.encode({
                id = request.id, seq = #logs, log = logs[#logs]
            }))
            print(('[%s][%s] %s'):format(resource, request.id, message))
        end
        local ctx = {
            id = request.id,
            resource = resource,
            alive = function() return state.alive and GetGameTimer() - start < request.timeoutMs end,
            log = log,
            sleep = function(ms)
                assert(type(ms) == 'number' and ms >= 0 and ms <= 60000, 'sleep expects 0..60000 milliseconds')
                assert(state.alive, 'Execution cancelled')
                Wait(ms)
                assert(state.alive and GetGameTimer() - start < request.timeoutMs, 'Execution cancelled or deadline exceeded')
            end,
            onCleanup = function(callback)
                assert(state.alive, 'Execution is no longer active')
                assert(type(callback) == 'function' and #cleanups < 100, 'Invalid or excessive cleanup callback')
                cleanups[#cleanups + 1] = callback
            end
        }
        local env = setmetatable({ ctx = ctx, print = log }, { __index = _G })
        local chunk, compileError = load(request.code, '@' .. resource .. '/mcp/' .. request.id .. '.lua', 't', env)
        if not chunk then
            active[request.id] = nil
            state.alive = false
            failure(request.id, compileError)
            return
        end
        -- Best-effort guard, not a sandbox: trusted code can bypass hooks or block in a native.
        local guarded = type(debug) == 'table' and type(debug.sethook) == 'function'
        local instructions = 0
        if guarded then
            debug.sethook(function()
                instructions = instructions + 10000
                if instructions >= 10000000 or not ctx.alive() then
                    error('Lua instruction budget or execution deadline exceeded', 0)
                end
            end, '', 10000)
        end
        local returned = table.pack(xpcall(function() return chunk(ctx) end, function(err)
            return debug and debug.traceback and debug.traceback(tostring(err), 2) or tostring(err)
        end))
        if guarded then debug.sethook() end
        state.alive = false
        active[request.id] = nil
        local ok = returned[1]
        local err
        if not ok then err = tostring(returned[2]) end
        for i = #cleanups, 1, -1 do
            local cleaned, cleanupError = pcall(cleanups[i])
            if not cleaned then
                ok = false
                err = (err or '') .. '\nCleanup failed: ' .. tostring(cleanupError)
            end
        end
        local encoded, result = pcall(function()
            local values = {}
            if returned[1] then
                for i = 2, math.min(returned.n, 101) do
                    values[#values + 1] = sanitize(returned[i], 0, {})
                end
            end
            return json.encode({
                ok = ok, error = err and err:sub(1, 8192),
                durationMs = math.max(0, GetGameTimer() - start),
                truncated = returned.n > 101
            }):sub(1, -2) .. ',"values":' .. arrayJson(values) .. ',"logs":' .. arrayJson(logs) .. '}'
        end)
        if not encoded then
            failure(request.id, 'Result serialization failed: ' .. tostring(result))
        elseif #result > MAX_RESULT then
            failure(request.id, 'Result exceeds transport size limit; return a smaller value')
        else
            TriggerEvent(prefix .. 'result', request.id, result)
        end
    end)
end)

AddEventHandler(prefix .. 'cancel', function(id)
    if active[id] then active[id].alive = false end
end)

local function stopping(name)
    if name ~= resource then return end
    for _, state in pairs(active) do state.alive = false end
end
AddEventHandler('onResourceStop', stopping)
AddEventHandler('onClientResourceStop', stopping)
