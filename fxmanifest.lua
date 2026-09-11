fx_version 'cerulean'
game 'gta5'
node_version '22'

author 'Dolu'
description 'Local development MCP: JavaScript, Lua and NUI'
version '0.1.2'

server_scripts {
    'lua/executor.lua',
    'dist/server.js'
}

client_scripts {
    'lua/executor.lua',
    'dist/client.js'
}

ui_page 'web/index.html'

files {
    'web/index.html',
    'dist/nui.js'
}
