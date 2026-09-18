# Qyris IP 形象生成方案 · qwen-image-3.0-pro

模型：qwen-image-3.0-pro（用户指定，非 skill 推荐第一梯队；简化/轮廓厚重感可能不及 GPT Image 2 / Seedance 5.0 Pro / Nano Banana Pro/2，属预期质量折损，不作为重试或过滤依据）。
批次：6 张一次性独立候选，不拼网格、不重试、不筛选、不后处理。
尺寸：1:1 方块，约 1536×1536；若服务原生输出为 1254×1254 则原样保留，不重采样。
约束投递路线：qwen-image-3.0-pro 按现代指令跟随型处理 —— `Constraints:` 行写进主 prompt，不另起 negative_prompt 字段。
若你的在线端**明确暴露独立的 negative_prompt 参数**，则改走"专用负向参数"路线：从下方每条 prompt 里删掉 `Constraints: ...` 那一段，改粘到末尾「专用负向参数载荷」框。

---

## 方向 · 配色 · 角落映射

| 标签 | 方向 | 产品连接 | 定义特征 | 角落 | IP 基色 1 | IP 基色 2 | 背景色 |
|---|---|---|---|---|---|---|---|
| A1 | 小驭驹（圆润小马驹） | "轻驭"驾驭统御多 Agent + 常驻桌宠陪伴 | 小拱形鬃毛冠 + 两只短 blunt 耳 | 左下 | 暖象牙白 #F3ECDD | Qyris 柔紫 #6C63FF | 柔薰衣草雾 #E6E1F0 |
| A2 | 小驭驹 | 同上，换色策略 | 同上 | 右下 | 灰玫瑰 #D98A8A | 深柔紫 #5B4FCF | 暖燕麦 #E7DFD0 |
| B1 | 圆滚滚记忆猫头鹰 | 分层记忆系统 · 跨会话回忆 · 本地嵌入不离机 | 一只 tiny blunt 短喙 + 两只大间距圆眼 | 左下 | 柔紫身 #8A82E8 | 淡暖金 #E8C96A | 雾板岩蓝灰 #D7DAE2 |
| B2 | 圆滚滚记忆猫头鹰 | 同上，换色策略 | 同上 | 右下 | 暖桃褐 #D9A98C | 紫眼斑 #6C63FF | 雾薄荷灰 #D5DED9 |
| C1 | 凝灵豆（圆润水滴 Agent 精灵） | 多 Agent 编排 · 本地优先工具 · Agentic 内核 | 一块小 blunt 圆角 visor/面板 + 两只小耳凸 | 左下 | Qyris 紫身 #6C63FF | 淡青 #9FD8DC | 暖米白 #EDE8E0 |
| C2 | 凝灵豆 | 同上，换色策略 | 同上 | 右下 | 深靛紫 #5142C9 | 暖淡黄 #E8D78A | 柔粉灰 #E6DCE3 |

三条 IP 规则：完整图恰好三种语义色 = 两种 IP 基色 + 一种背景色；面部小标记复用其中一种 IP 色而非引入第四色；背景统一轻微降饱和、保持清晰带色、不灰不浊。

---

## 6 条可直接粘贴的主 prompt

### A1 · 小驭驹 · 左下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted lavender-mist (a gently muted, restrained soft lavender-grey). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-left emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby pony/foal IP character on the background, reduced to one soft rounded continuous body silhouette and one defining feature: a small arched mane crest on top of the head plus two short blunt rounded ears. Show both ears. Merge the legs into the body; do not draw separate hooves or legs.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are warm ivory-white for the body and Qyris soft violet for the mane crest, ears, and tiny facial marks; organize both into broad purposeful masses and reuse the violet for facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-left, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or left side is welcome when it strengthens the corner emergence. Preserve both ears. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### A2 · 小驭驹 · 右下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted warm oat (a gently muted, restrained warm oatmeal beige). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-right emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby pony/foal IP character on the background, reduced to one soft rounded continuous body silhouette and one defining feature: a small arched mane crest on top of the head plus two short blunt rounded ears. Show both ears. Merge the legs into the body; do not draw separate hooves or legs.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are dusty rose for the body and deep soft violet for the mane crest, ears, and tiny facial marks; organize both into broad purposeful masses and reuse the violet for facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-right, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or right side is welcome when it strengthens the corner emergence. Preserve both ears. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### B1 · 记忆猫头鹰 · 左下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted slate blue-grey (a gently muted, restrained soft slate mist). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-left emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby owl IP character on the background, reduced to one plump egg-shaped continuous body silhouette and one defining feature: one tiny short blunt beak, plus two big wide-set round eyes as the dominant facial element. Do not draw wings, feathers, or talons.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are soft violet for the body and pale warm gold for the tiny beak and facial marks around the eyes; organize both into broad purposeful masses and reuse the gold for facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-left, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or left side is welcome when it strengthens the corner emergence. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### B2 · 记忆猫头鹰 · 右下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted mint-grey (a gently muted, restrained soft mint haze). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-right emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby owl IP character on the background, reduced to one plump egg-shaped continuous body silhouette and one defining feature: one tiny short blunt beak, plus two big wide-set round eyes as the dominant facial element. Do not draw wings, feathers, or talons.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are warm peach-taupe for the body and violet for the eye marks and tiny beak; organize both into broad purposeful masses and reuse the violet for facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-right, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or right side is welcome when it strengthens the corner emergence. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### C1 · 凝灵豆 · 左下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted warm off-white (a gently muted, restrained warm cream). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-left emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby teardrop-bean spirit IP character on the background, reduced to one soft rounded continuous teardrop/bean body silhouette and one defining feature: one small blunt rounded visor/face panel across the upper face, plus two tiny round ear bumps on top. Show both ear bumps.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are Qyris violet for the body and pale cyan for the visor/face panel and tiny facial marks; organize both into broad purposeful masses and reuse the cyan for facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-left, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or left side is welcome when it strengthens the corner emergence. Preserve both ear bumps. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

### C2 · 凝灵豆 · 右下

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted soft pink-grey (a gently muted, restrained dusty pink haze). Keep this background color visible in every open area and in every corner not occupied by the character; the lower-right emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby teardrop-bean spirit IP character on the background, reduced to one soft rounded continuous teardrop/bean body silhouette and one defining feature: one small blunt rounded visor/face panel across the upper face, plus two tiny round ear bumps on top. Show both ear bumps.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. The two IP colors are deep indigo-violet for the body and warm pale yellow for the visor/face panel and tiny facial marks; organize both into broad purposeful masses and reuse the warm yellow for facial marks. Choose the background independently. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the lower-right, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or right side is welcome when it strengthens the corner emergence. Preserve both ear bumps. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

---

## 专用负向参数载荷（仅当你的在线端暴露独立 negative_prompt 字段时使用）

若走专用负向参数路线：从上面每条 prompt 里删掉 `Constraints: ...` 那一段，把下面这段粘进 negative_prompt 字段：

```text
text, watermark, borders, frames, cards, presentation masks, extra subjects, scenery, thin fragile lines, sharp tips, photorealistic materials, strong three-dimensional rendering, external cast shadows
```

---

## 交付与命名建议

跑完把 6 张图原样存到 `build/ip/`，文件名对应标签：

```
build/ip/A1.png  小驭驹 · 左下 · 象牙白+紫 / 薰衣草雾
build/ip/A2.png  小驭驹 · 右下 · 灰玫瑰+深紫 / 暖燕麦
build/ip/B1.png  记忆猫头鹰 · 左下 · 柔紫+淡金 / 板岩蓝灰
build/ip/B2.png  记忆猫头鹰 · 右下 · 桃褐+紫 / 薄荷灰
build/ip/C1.png  凝灵豆 · 左下 · 紫身+淡青 / 暖米白
build/ip/C2.png  凝灵豆 · 右下 · 深靛紫+暖黄 / 粉灰
```

一次性产出、原样交付，不因背景/配色/细节/构图自动重试或后处理；要换方向或补抽再单独开新一轮。
