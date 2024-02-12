#!/usr/bin/env lua

-- Template file

function generateDiary()
  template = os.date("# Journal - %A %Y-%m-%d")
  template = template .. [[


## Daily Checklist

- [ ] Update [Brag Doc](../brag)
- [ ] prod support chasing
  - [ ] no updates
  - [ ] over SLA
  - [ ] close to SLA
  - [ ] triage

## Tasks Due Today (TW) | -COMPLETED (+OVERDUE or +urgent or due.by:{{DATE}} or +ACTIVE) | due:{{DATE}}

## Tasks Completed Today (TW) | end:{{DATE}} | end:{{DATE}} due:{{DATE}}

## Notes
]]
  return template:gsub("%{{DATE}}", os.date("%Y-%m-%d"))
end

local function lines(str)
  local result = {}
  for line in str:gmatch("([^\n]*)\n?") do
    table.insert(result, line)
  end
  return result
end

-- au BufNewFile ~/Documents/notes/diary/*.md lua require("vimwikidiary"); setDiaryTemplate(); vim.cmd("TaskWikiBufferSave")
function setDiaryTemplate()
  if table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '') == '' then
    vim.api.nvim_buf_set_text(0, 0, 0, 0, 0, lines(generateDiary()))
  end
end

if not vim then
  print(generateDiary())
end
