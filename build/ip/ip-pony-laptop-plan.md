# Qyris IP · 抱笔记本工作的小马驹 · qwen-image-3.0-pro

主体（用户显式指定）：抱着笔记本电脑工作的小马驹。
模型：qwen-image-3.0-pro（用户指定，非 skill 推荐第一梯队；质量折损属预期，不触发重试/过滤）。
批次：6 张一次性独立候选，不拼网格、不重试、不筛选、不后处理。
尺寸：1:1 方块，约 1536×1536；服务原生 1254×1254 则原样保留，不重采样。
约束投递路线：按现代指令跟随型 —— `Constraints:` 行写进主 prompt，不另起 negative_prompt。
若你的在线端**明确暴露独立 negative_prompt 字段**，改走"专用负向参数"路线：从每条 prompt 删掉 `Constraints: ...` 段，粘末尾「专用负向参数载荷」。

简化关键：笔记本 = 一块圆角板，屏幕留白、无键盘、无端口、无文字代码（Constraints 已禁文字）；整块笔记本与鬃毛/耳共用同一种 IP 基色，保证全图恰好三语义色 = 马身(IP1) + 鬃/耳/笔记本(IP2) + 背景(1)。

---

## 方向 · 姿态 · 配色 · 角落映射

| 标签 | 方向 | 姿态 | 角落 | IP1 马身 | IP2 鬃/耳/笔记本 | 背景色 |
|---|---|---|---|---|---|---|
| A1 | 抱本贴胸型 | 立式笔记本板贴胸前，头微低凝视 | 左下 | 暖象牙白 #F3ECDD | Qyris 柔紫 #6C63FF | 柔薰衣草雾 #E6E1F0 |
| A2 | 抱本贴胸型 | 同上，换色 | 右下 | 灰玫瑰 #D98A8A | 深柔紫 #5B4FCF | 暖燕麦 #E7DFD0 |
| B1 | 膝上托盘型 | 坐姿，横置笔记本板平放身前如托盘 | 左下 | 柔紫身 #8A82E8 | 淡暖金 #E8C96A | 雾板岩蓝灰 #D7DAE2 |
| B2 | 膝上托盘型 | 同上，换色 | 右下 | 暖桃褐 #D9A98C | 紫色 #6C63FF | 雾薄荷灰 #D5DED9 |
| C1 | 探头越顶型 | 头从面朝观众的笔记本板顶沿探出 | 左下 | Qyris 紫身 #6C63FF | 淡青 #9FD8DC | 暖米白 #EDE8E0 |
| C2 | 探头越顶型 | 同上，换色 | 右下 | 深靛紫 #5142C9 | 暖淡黄 #E8D78A | 柔粉灰 #E6DCE3 |

---

## 6 条可直接粘贴的主 prompt

### A1 · 抱本贴胸型 · 左下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted lavender-mist (a gently muted, restrained soft lavender-grey). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-left emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby pony/foal IP character hugging a simple rounded laptop, on the background. The body is one soft rounded continuous silhouette with one small arched mane crest on top and two short blunt rounded ears as the defining feature; show both ears. The pony holds the laptop as a single simple rounded rectangular slab hugged vertically against its chest, head slightly lowered, gazing calmly at it. Merge the legs into the body; draw no separate hooves. The laptop screen is a blank unmarked surface with no keyboard, no ports, no text, no code, and no brand.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are warm ivory-white for the pony body and Qyris soft violet for the mane crest, ears, and the whole laptop slab; reuse the violet for any tiny facial marks. Organize both into broad purposeful masses. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-left, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or left side is welcome when it strengthens the corner emergence. Preserve both ears. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### A2 · 抱本贴胸型 · 右下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted warm oat (a gently muted, restrained warm oatmeal beige). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-right emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby pony/foal IP character hugging a simple rounded laptop, on the background. The body is one soft rounded continuous silhouette with one small arched mane crest on top and two short blunt rounded ears as the defining feature; show both ears. The pony holds the laptop as a single simple rounded rectangular slab hugged vertically against its chest, head slightly lowered, gazing calmly at it. Merge the legs into the body; draw no separate hooves. The laptop screen is a blank unmarked surface with no keyboard, no ports, no text, no code, and no brand.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are dusty rose for the pony body and deep soft violet for the mane crest, ears, and the whole laptop slab; reuse the violet for any tiny facial marks. Organize both into broad purposeful masses. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-right, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or right side is welcome when it strengthens the corner emergence. Preserve both ears. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### B1 · 膝上托盘型 · 左下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted slate blue-grey (a gently muted, restrained soft slate mist). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-left emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby pony/foal IP character working at a simple rounded laptop, on the background. The body is one soft rounded continuous silhouette sitting upright, with one small arched mane crest on top and two short blunt rounded ears as the defining feature; show both ears. The laptop is a single simple rounded rectangular slab resting flat and horizontal in front of the pony like a small tray, with one foreleg draped gently over its near edge; the pony looks down at it calmly. Merge the legs into the body; draw no separate hooves. The laptop screen is a blank unmarked surface with no keyboard, no ports, no text, no code, and no brand.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are soft violet for the pony body and pale warm gold for the mane crest, ears, and the whole laptop slab; reuse the gold for any tiny facial marks. Organize both into broad purposeful masses. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-left, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or left side is welcome when it strengthens the corner emergence. Preserve both ears. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### B2 · 膝上托盘型 · 右下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted mint-grey (a gently muted, restrained soft mint haze). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-right emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby pony/foal IP character working at a simple rounded laptop, on the background. The body is one soft rounded continuous silhouette sitting upright, with one small arched mane crest on top and two short blunt rounded ears as the defining feature; show both ears. The laptop is a single simple rounded rectangular slab resting flat and horizontal in front of the pony like a small tray, with one foreleg draped gently over its near edge; the pony looks down at it calmly. Merge the legs into the body; draw no separate hooves. The laptop screen is a blank unmarked surface with no keyboard, no ports, no text, no code, and no brand.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are warm peach-taupe for the pony body and violet for the mane crest, ears, and the whole laptop slab; reuse the violet for any tiny facial marks. Organize both into broad purposeful masses. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-right, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or right side is welcome when it strengthens the corner emergence. Preserve both ears. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### C1 · 探头越顶型 · 左下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted warm off-white (a gently muted, restrained warm cream). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-left emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby pony/foal IP character behind a simple rounded laptop, on the background. The body is one soft rounded continuous silhouette with one small arched mane crest on top and two short blunt rounded ears as the defining feature; show both ears. The laptop is a single simple rounded rectangular slab standing upright and facing the viewer, and the pony's head peeks calmly over the top edge of the laptop, two big wide-set eyes looking forward. Merge the legs into the body; draw no separate hooves. The laptop screen is a blank unmarked surface with no keyboard, no ports, no text, no code, and no brand.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are Qyris violet for the pony body and pale cyan for the mane crest, ears, and the whole laptop slab; reuse the cyan for any tiny facial marks. Organize both into broad purposeful masses. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-left, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or left side is welcome when it strengthens the corner emergence. Preserve both ears. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### C2 · 探头越顶型 · 右下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted soft pink-grey (a gently muted, restrained dusty pink haze). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-right emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby pony/foal IP character behind a simple rounded laptop, on the background. The body is one soft rounded continuous silhouette with one small arched mane crest on top and two short blunt rounded ears as the defining feature; show both ears. The laptop is a single simple rounded rectangular slab standing upright and facing the viewer, and the pony's head peeks calmly over the top edge of the laptop, two big wide-set eyes looking forward. Merge the legs into the body; draw no separate hooves. The laptop screen is a blank unmarked surface with no keyboard, no ports, no text, no code, and no brand.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are deep indigo-violet for the pony body and warm pale yellow for the mane crest, ears, and the whole laptop slab; reuse the warm yellow for any tiny facial marks. Organize both into broad purposeful masses. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-right, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or right side is welcome when it strengthens the corner emergence. Preserve both ears. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

---

## 专用负向参数载荷（仅当你的在线端暴露独立 negative_prompt 字段时使用）

走专用负向参数路线时：从上面每条 prompt 删掉 `Constraints: ...` 段，把下面这段粘进 negative_prompt 字段：

```text
text, watermark, borders, frames, cards, presentation masks, extra subjects, scenery, thin fragile lines, sharp tips, photorealistic materials, strong three-dimensional rendering, external cast shadows
```

---

## 交付与命名建议

跑完把 6 张图原样存到 `build/ip/`：

```
build/ip/pony-laptop-A1.png  抱本贴胸 · 左下 · 象牙白身+紫鬃紫本 / 薰衣草雾
build/ip/pony-laptop-A2.png  抱本贴胸 · 右下 · 灰玫瑰身+深紫本 / 暖燕麦
build/ip/pony-laptop-B1.png  膝上托盘 · 左下 · 柔紫身+淡金本 / 板岩蓝灰
build/ip/pony-laptop-B2.png  膝上托盘 · 右下 · 桃褐身+紫本 / 薄荷灰
build/ip/pony-laptop-C1.png  探头越顶 · 左下 · 紫身+淡青本 / 暖米白
build/ip/pony-laptop-C2.png  探头越顶 · 右下 · 深靛紫身+暖黄本 / 粉灰
```

一次性产出、原样交付，不因背景/配色/细节/构图自动重试或后处理；要换姿态、补抽或对某张再开新一轮独立候选，再说。
