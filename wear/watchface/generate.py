"""Generate watchface.xml from the dial geometry (WFF box 450). Run from wear/watchface: python3 generate.py"""
import math, sys

C, K = 225.0, 1.30
LW = 2.0  # thin-line weight: bezel, hour ticks and minute hand
INK, MUTED, LINE_STRONG, PRIMARY = "#e7e9f0", "#a2a8b8", "#7d8496", "#b6c2ff"
out_xml = sys.argv[1] if len(sys.argv) > 1 else "src/main/res/raw/watchface.xml"

def f(v): return f"{v:.2f}".rstrip("0").rstrip(".")
def pt(r, a):
    a = math.radians(a)
    return C + r * math.sin(a), C - r * math.cos(a)

R_BEZEL = 150 * K
ticks = []  # (r_in, r_out, width, color, angle)
for h in range(24):
    if h % 6 == 0: L, w, c = 12, 2.5, INK
    elif h % 3 == 0: L, w, c = 7, 1.25, LINE_STRONG
    else: L, w, c = 4, 1.25, LINE_STRONG
    ticks.append((R_BEZEL - L * K, R_BEZEL, w * K * LW, c, h * 15))


# Edge slots: centred on the diagonals, 60 deg wide, r 175..224.
R_IN, R_OUT = R_BEZEL, 225.0
R_MID = (R_IN + R_OUT) / 2
APP = "com.deluispablo.healthtracker"
FITBIT_CALORIES = ("com.fitbit.FitbitMobile/com.google.android.wearable.fitbit.mainapp.complications"
                   ".offloadable.calories.OffloadableCaloriesComplicationDataSourceService")
# Each diagonal tints its icon and progress; calories falls back to empty when Fitbit is missing.
slots = [(1, 45, "WATCH_BATTERY", "RANGED_VALUE", "#5ccf97"), (2, 135, "STEP_COUNT", "GOAL_PROGRESS", "#8ea9ff"),
         (3, 225, "EMPTY", "EMPTY", "#f0a650", FITBIT_CALORIES), (4, 315, "WORLD_CLOCK", "SHORT_TEXT", "#6fc3e6")]

def edge_slot(sid, mid, provider, ptype, color, primary=None):
    # Concentric-style edge slot (after lukakilic/concentric-watch-face, MIT): icon, value and
    # progress share one curved line centred on the diagonal; lower slots read counter-clockwise.
    half, rg, fs, ico = 35.0, 208.0, 19, 25
    s, e = mid - half, mid + half
    bottom = 90 < mid < 270
    dpc = fs * 0.6 / (math.pi * rg / 180)  # degrees per character
    ico_deg = (ico + fs * 0.3) / (math.pi * rg / 180)
    d = 2 * rg
    direction = "COUNTER_CLOCKWISE" if bottom else "CLOCKWISE"
    t_start, t_end = (e, s) if bottom else (s, e)

    def text(align, icon):
        img = f"""
                <InlineImage resource="blank" source="COMPLICATION.MONOCHROMATIC_IMAGE" color="{color}" width="{ico}" height="{ico}"/>
                <Template>%s<Parameter expression="&#160;"/></Template>""" if icon else ""
        return f"""
        <PartText x="0" y="0" width="450" height="450">
          <TextCircular centerX="{f(C)}" centerY="{f(C)}" width="{f(d)}" height="{f(d)}" startAngle="{f(t_start)}" endAngle="{f(t_end)}" direction="{direction}" align="{align}" ellipsis="FALSE">
            <Font family="SYNC_TO_DEVICE" size="{fs}" weight="MEDIUM" color="{INK}">{img}
              <Upper><Template>%s<Parameter expression="[COMPLICATION.TEXT]"/></Template></Upper>
            </Font>
          </TextCircular>
        </PartText>"""

    def bar(fraction, icon):
        lead = f"{f(ico_deg if icon else 0)} + textLength([COMPLICATION.TEXT]) * {f(dpc)} + 2"
        frac = f"clamp({fraction}, 0, 1)"
        if bottom:  # grows from the text end towards the start angle
            edge = f"{f(e)} - ({lead})"
            track = f"""<Arc centerX="{f(C)}" centerY="{f(C)}" width="{f(d)}" height="{f(d)}" startAngle="{f(s)}" endAngle="{f(e)}">
            <Transform target="endAngle" value="{edge}"/>
            <Stroke color="#33ffffff" thickness="4" cap="ROUND"/>
          </Arc>
          <Arc centerX="{f(C)}" centerY="{f(C)}" width="{f(d)}" height="{f(d)}" startAngle="{f(s)}" endAngle="{f(e)}">
            <Transform target="endAngle" value="{edge}"/>
            <Transform target="startAngle" value="{edge} - {frac} * ({edge} - {f(s)})"/>
            <Stroke color="{color}" thickness="5" cap="ROUND"/>
          </Arc>"""
        else:
            edge = f"{f(s)} + {lead}"
            track = f"""<Arc centerX="{f(C)}" centerY="{f(C)}" width="{f(d)}" height="{f(d)}" startAngle="{f(s)}" endAngle="{f(e)}">
            <Transform target="startAngle" value="{edge}"/>
            <Stroke color="#33ffffff" thickness="4" cap="ROUND"/>
          </Arc>
          <Arc centerX="{f(C)}" centerY="{f(C)}" width="{f(d)}" height="{f(d)}" startAngle="{f(s)}" endAngle="{f(e)}">
            <Transform target="startAngle" value="{edge}"/>
            <Transform target="endAngle" value="{edge} + {frac} * ({f(e)} - ({edge}))"/>
            <Stroke color="{color}" thickness="5" cap="ROUND"/>
          </Arc>"""
        return f"""
        <PartDraw x="0" y="0" width="450" height="450">
          {track}
        </PartDraw>{text("START", icon)}"""

    def progress(fraction):
        return f"""
        <Condition>
          <Expressions>
            <Expression name="noIcon">[COMPLICATION.MONOCHROMATIC_IMAGE] == null</Expression>
          </Expressions>
          <Compare expression="noIcon">{bar(fraction, False)}
          </Compare>
          <Default>{bar(fraction, True)}
          </Default>
        </Condition>"""

    ranged = "([COMPLICATION.RANGED_VALUE_VALUE] - [COMPLICATION.RANGED_VALUE_MIN]) / ([COMPLICATION.RANGED_VALUE_MAX] - [COMPLICATION.RANGED_VALUE_MIN])"
    goal = "[COMPLICATION.GOAL_PROGRESS_VALUE] / [COMPLICATION.GOAL_PROGRESS_TARGET_VALUE]"
    return f"""
    <ComplicationSlot x="0" y="0" width="450" height="450" slotId="{sid}" displayName="slot_{sid}_label" supportedTypes="RANGED_VALUE GOAL_PROGRESS SHORT_TEXT EMPTY" isCustomizable="TRUE">
      <DefaultProviderPolicy defaultSystemProvider="{provider}" defaultSystemProviderType="{ptype}"{f' primaryProvider="{primary}" primaryProviderType="SHORT_TEXT"' if primary else ""}/>
      <BoundingArc centerX="{f(C)}" centerY="{f(C)}" width="{f(2 * R_OUT)}" height="{f(2 * R_OUT)}" thickness="{f(R_OUT - R_IN)}" startAngle="{f(s)}" endAngle="{f(e)}" isRoundEdge="TRUE"/>
      <Variant mode="AMBIENT" target="alpha" value="0"/>
      <Complication type="RANGED_VALUE">{progress(ranged)}
      </Complication>
      <Complication type="GOAL_PROGRESS">{progress(goal)}
      </Complication>
      <Complication type="SHORT_TEXT">
        <Condition>
          <Expressions>
            <Expression name="noIcon">[COMPLICATION.MONOCHROMATIC_IMAGE] == null</Expression>
          </Expressions>
          <Compare expression="noIcon">{text("CENTER", False)}
          </Compare>
          <Default>{text("CENTER", True)}
          </Default>
        </Condition>
      </Complication>
      <Complication type="EMPTY"/>
    </ComplicationSlot>"""

def line(x1, y1, x2, y2, w, c):
    return f"""<Line startX="{f(x1)}" startY="{f(y1)}" endX="{f(x2)}" endY="{f(y2)}"><Stroke color="{c}" thickness="{f(w)}" cap="ROUND"/></Line>"""

def hand(name, back, length, width, halo, color, angle_expr):
    y1, y2 = C + back * K, C - length * K
    return f"""
    <PartDraw x="0" y="0" width="450" height="450" name="{name}">
      <Transform target="angle" value="{angle_expr}"/>
      {line(C, y1, C, y2, halo * K, "#000000")}
      {line(C, y1, C, y2, width * K, color)}
    </PartDraw>"""

tick_xml = "\n      ".join(
    f"""<Line startX="{f(pt(ri, a)[0])}" startY="{f(pt(ri, a)[1])}" endX="{f(pt(ro, a)[0])}" endY="{f(pt(ro, a)[1])}"><Stroke color="{c}" thickness="{f(w)}"/></Line>"""
    for ri, ro, w, c, a in ticks)

HOUR_LEN = (R_BEZEL - 4) / K  # the hour hand reaches the bezel; minutes are 10 % shorter
HOUR = "([HOUR_0_23] * 60 + [MINUTE]) / 4"
MINUTE = "[MINUTE] * 6"  # minute steps: no per-second redraws
hub_r = 6 * K * 1.3
SPOT = round(R_BEZEL * math.sqrt(2))  # tap square inside the bezel: opens the log menu

xml = f"""<?xml version="1.0" encoding="utf-8"?>
<!-- Edge complication layout adapted from concentric-watch-face by Luka Kilic (MIT); see wear/THIRD_PARTY_NOTICES.md. -->
<WatchFace width="450" height="450">
  <Metadata key="CLOCK_TYPE" value="ANALOG"/>
  <Metadata key="PREVIEW_TIME" value="14:10:00"/>
  <Scene backgroundColor="#ff000000">
    <ComplicationSlot x="0" y="0" width="450" height="450" slotId="0" displayName="dial_label" supportedTypes="SMALL_IMAGE EMPTY" isCustomizable="FALSE">
      <DefaultProviderPolicy defaultSystemProvider="EMPTY" defaultSystemProviderType="EMPTY" primaryProvider="com.deluispablo.healthtracker/com.deluispablo.healthtracker.DialComplicationService" primaryProviderType="SMALL_IMAGE"/>
      <BoundingOval x="{f(C - R_BEZEL)}" y="{f(C - R_BEZEL)}" width="{f(2 * R_BEZEL)}" height="{f(2 * R_BEZEL)}"/>
      <ScreenReader stringId="dial_description"/>
      <Complication type="SMALL_IMAGE">
        <PartImage x="0" y="0" width="450" height="450">
          <Variant mode="AMBIENT" target="alpha" value="0"/>
          <Image resource="[COMPLICATION.SMALL_IMAGE]"/>
        </PartImage>
        <PartImage x="0" y="0" width="450" height="450" alpha="0">
          <Variant mode="AMBIENT" target="alpha" value="255"/>
          <Image resource="[COMPLICATION.SMALL_IMAGE_AMBIENT]"/>
        </PartImage>
      </Complication>
      <Complication type="EMPTY">
        <PartText x="105" y="250" width="240" height="30">
          <Variant mode="AMBIENT" target="alpha" value="0"/>
          <Text align="CENTER">
            <Font family="SYNC_TO_DEVICE" size="18" color="{MUTED}">Toca para activar</Font>
          </Text>
        </PartText>
      </Complication>
    </ComplicationSlot>
    <PartDraw x="{round(C - SPOT / 2)}" y="{round(C - SPOT / 2)}" width="{f(SPOT)}" height="{f(SPOT)}" name="mood_spot">
      <Launch target="{APP}"/>
      <Rectangle x="0" y="0" width="{f(SPOT)}" height="{f(SPOT)}">
        <Fill color="#00000000"/>
      </Rectangle>
    </PartDraw>
    <PartDraw x="0" y="0" width="450" height="450" name="bezel">
      <Ellipse x="{f(C - R_BEZEL)}" y="{f(C - R_BEZEL)}" width="{f(2 * R_BEZEL)}" height="{f(2 * R_BEZEL)}">
        <Stroke color="{LINE_STRONG}" thickness="{f(1.5 * K * LW)}"/>
      </Ellipse>
      {tick_xml}
    </PartDraw>{"".join(edge_slot(*s) for s in slots)}{hand("minute_hand", 10, HOUR_LEN * 0.9, 6 / K, 11.4 / K, MUTED, MINUTE)}{hand("hour_hand", 12, HOUR_LEN, 10 / K, 16 / K, PRIMARY, HOUR)}
    <PartDraw x="0" y="0" width="450" height="450" name="hub">
      <Ellipse x="{f(C - hub_r)}" y="{f(C - hub_r)}" width="{f(2 * hub_r)}" height="{f(2 * hub_r)}">
        <Fill color="{PRIMARY}"/>
        <Stroke color="#000000" thickness="{f(2 * K)}"/>
      </Ellipse>
    </PartDraw>
  </Scene>
</WatchFace>
"""
open(out_xml, "w").write(xml)
