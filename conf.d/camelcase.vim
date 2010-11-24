" Plugins to move around camelcase words, and convert camelcase and snakecase

map <silent> w <Plug>CamelCaseMotion_w
map <silent> b <Plug>CamelCaseMotion_b
map <silent> e <Plug>CamelCaseMotion_e
sunmap w
sunmap b
sunmap e

map <Leader>c <Plug>(operator-camelize)
map <Leader>C <Plug>(operator-decamelize)
