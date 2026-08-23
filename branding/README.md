# Branding — Remote Pi

Identidade visual oficial. Fonte de verdade: arquivos SVG (escaláveis).
PNGs derivados gerados via ferramenta externa quando necessário.

## Paleta

| Cor | Hex | Uso |
|---|---|---|
| Preto puro | `#000000` | Background (full + adaptive icon bg) |
| Branco puro | `#FFFFFF` | Símbolo π (foreground principal) |
| Azul Pi | `#4FC3F7` | Bolinha característica |

## Arquivos

| Arquivo | Conteúdo | Uso recomendado |
|---|---|---|
| `logo-full.svg` | Background preto + π branco + bolinha azul | Logo single-piece (favicon, README header, site, PWA) |
| `logo-foreground.svg` | π + bolinha em fundo transparente | Transparent logo mark for compositing |
| `logo-background.svg` | Preto sólido 1024×1024 | Solid background layer for branded surfaces |
| `logo-monochrome.svg` | Silhueta branca completa | Monochrome logo mark |
| `banner.svg` / `banner.png` | Banner 1280×640 horizontal — π à esquerda + título + tagline + comando install + URL | Card de pacote pi.dev (`pi.image` no package.json), README hero do GitHub, social preview |

Todos os arquivos: **1024×1024** viewBox, safe zone Android-compatível (~66% central).

## Como converter pra PNG

Nenhuma ferramenta de conversão hoje instalada no projeto. Opções pra
gerar PNG quando necessário:

### Via `rsvg-convert` (mais simples)

```bash
brew install librsvg
rsvg-convert -w 1024 -h 1024 logo-foreground.svg -o logo-foreground.png
rsvg-convert -w 1024 -h 1024 logo-background.svg -o logo-background.png
rsvg-convert -w 1024 -h 1024 logo-monochrome.svg -o logo-monochrome.png
rsvg-convert -w 1024 -h 1024 logo-full.svg -o logo-full.png
```

### Via ImageMagick

```bash
brew install imagemagick
magick -background none -resize 1024x1024 logo-foreground.svg logo-foreground.png
```

### Via Inkscape (CLI)

```bash
inkscape --export-type=png --export-width=1024 logo-foreground.svg
```

### Via Figma/online

- [https://cloudconvert.com/svg-to-png](https://cloudconvert.com/svg-to-png)
- [https://svgtopng.com](https://svgtopng.com)

## Tamanhos padrão exportar

Antes de usar no site ou na PWA, gere as variantes necessárias:

| Plataforma | Tamanho | Arquivo fonte |
|---|---|---|
| PWA/site icon | 512×512 PNG | `logo-full.svg` |
| Transparent mark | 432×432 PNG transparente | `logo-foreground.svg` |
| Monochrome mark | 432×432 PNG transparente | `logo-monochrome.svg` |
| Favicon | 32×32, 16×16 PNG | `logo-full.svg` |
| npm registry README | 512×512 PNG | `logo-full.svg` |

> Logo exports keep the important mark centered inside a conservative safe zone,
> so the same assets remain legible in browser icons and compact UI surfaces.

## Atualização

Mudanças visuais: editar SVG (Figma → export SVG é OK). Regenerar PNGs
derivados nos pontos de uso (site, PWA, package README).

Antes de mudar paleta ou silhueta, atualizar este README com a nova
versão da identidade visual + razão da mudança.
