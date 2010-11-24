
let g:load_doxygen_syntax=1
let g:DoxygenToolkit_authorName="Ryan Wooden (100079872)"
au filetype c,cpp map <leader>d :Dox<CR>
au FileType objc set syntax=objc.doxygen
autocmd FileType python runtime syntax/doxygen.vim
