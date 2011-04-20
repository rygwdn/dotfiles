command! AutoRubber exec "au BufWritePost " . expand('%') . " Rubber"
