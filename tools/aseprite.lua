--[[
  Un PNG rendu par NBPIX, transformé en .aseprite prêt à finir à la main.

  Ce que le script fait, et rien de plus :
    - ouvre le PNG ;
    - passe le sprite en mode indexé, donc sur une palette fixe, comme un sprite de console ;
    - enregistre un .aseprite à côté.

  Ce qu'il ne fait PAS, volontairement : poser l'image d'origine en calque de référence. Un calque
  de référence se crée en une action dans Aseprite (Calque > Nouveau calque de référence…) et
  accepte une image en vraies couleurs là où un sprite indexé ne le pourrait pas. Automatiser ce
  qu'un clic fait mieux n'apporte rien.

  Appelé par tools/aseprite.mjs, qui passe les chemins.
]]

local params = app.params
local from = params.sprite
local into = params.out

if not from or from == '' then
  print("aseprite.lua : il manque --script-param sprite=<chemin.png>")
  return
end

local sprite = Sprite { fromFile = from }
if not sprite then
  print("aseprite.lua : " .. from .. " n'a pas pu être ouvert")
  return
end

-- Indexé : les pixels deviennent des numéros de palette, ce que toute console faisait et ce que
-- NayosBeat attend de ses planches.
app.command.ChangePixelFormat { format = 'indexed' }

sprite:saveAs(into)
print('écrit ' .. into .. ' (' .. sprite.width .. ' x ' .. sprite.height .. ', '
  .. #sprite.palettes[1] .. ' couleurs)')
