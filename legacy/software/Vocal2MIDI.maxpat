{
	"patcher" : {
		"fileversion" : 1,
		"appversion" : {
			"major" : 8,
			"minor" : 6,
			"revision" : 2,
			"architecture" : "x64"
		},
		"rect" : [ 80.0, 80.0, 940.0, 340.0 ],
		"bglocked" : 0,
		"openinpresentation" : 0,
		"default_fontsize" : 12.0,
		"default_fontface" : 0,
		"default_fontname" : "Arial",
		"gridonopen" : 1,
		"gridsize" : [ 10.0, 10.0 ],
		"gridsnaponopen" : 1,
		"objectsnaponopen" : 1,
		"statusbarvisible" : 2,
		"toolbarvisible" : 1,
		"boxes" : [

			{
				"box" : {
					"id" : "obj-notein",
					"maxclass" : "newobj",
					"numinlets" : 0,
					"numoutlets" : 3,
					"outlettype" : [ "int", "int", "int" ],
					"patching_rect" : [ 15.0, 12.0, 170.0, 22.0 ],
					"text" : "notein"
				}
			},

			{
				"box" : {
					"id" : "obj-port-hint",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 195.0, 15.0, 440.0, 16.0 ],
					"text" : "\u2191 double-click to select port: Voice2Piano_Layer1",
					"fontsize" : 11.0,
					"fontface" : 0
				}
			},

			{
				"box" : {
					"id" : "obj-title",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 720.0, 12.0, 205.0, 18.0 ],
					"text" : "Voice2Piano Monitor",
					"fontsize" : 13.0,
					"fontface" : 1
				}
			},

			{
				"box" : {
					"id" : "obj-kslider",
					"maxclass" : "kslider",
					"numinlets" : 2,
					"numoutlets" : 2,
					"outlettype" : [ "int", "int" ],
					"patching_rect" : [ 15.0, 42.0, 910.0, 68.0 ],
					"low" : 21,
					"high" : 108
				}
			},

			{
				"box" : {
					"id" : "obj-note-label",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 15.0, 120.0, 180.0, 16.0 ],
					"text" : "Current note",
					"fontface" : 1
				}
			},

			{
				"box" : {
					"id" : "obj-note-display",
					"maxclass" : "message",
					"numinlets" : 2,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 15.0, 138.0, 180.0, 36.0 ],
					"fontsize" : 22.0,
					"fontface" : 1,
					"text" : "\u2014"
				}
			},

			{
				"box" : {
					"id" : "obj-midi-label",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 205.0, 120.0, 65.0, 16.0 ],
					"text" : "MIDI",
					"fontface" : 1
				}
			},

			{
				"box" : {
					"id" : "obj-midi-num",
					"maxclass" : "number",
					"numinlets" : 1,
					"numoutlets" : 2,
					"outlettype" : [ "", "bang" ],
					"patching_rect" : [ 205.0, 138.0, 65.0, 36.0 ],
					"fontsize" : 16.0
				}
			},

			{
				"box" : {
					"id" : "obj-vel-label",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 280.0, 120.0, 70.0, 16.0 ],
					"text" : "Velocity",
					"fontface" : 1
				}
			},

			{
				"box" : {
					"id" : "obj-vel-num",
					"maxclass" : "number",
					"numinlets" : 1,
					"numoutlets" : 2,
					"outlettype" : [ "", "bang" ],
					"patching_rect" : [ 280.0, 138.0, 65.0, 36.0 ],
					"fontsize" : 16.0
				}
			},

			{
				"box" : {
					"id" : "obj-mode-label",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 490.0, 120.0, 150.0, 16.0 ],
					"text" : "Detection mode",
					"fontface" : 1
				}
			},

			{
				"box" : {
					"id" : "obj-mode-umenu",
					"maxclass" : "umenu",
					"numinlets" : 1,
					"numoutlets" : 3,
					"outlettype" : [ "int", "", "" ],
					"patching_rect" : [ 490.0, 138.0, 255.0, 22.0 ],
					"items" : [
						"Live \u2014 Instrument", 0.0,
						"Live \u2014 Voice", 0.0,
						"Live \u2014 Chord", 0.0,
						"File \u2014 Voice", 0.0,
						"File \u2014 Instrumental", 0.0,
						"File \u2014 Mixed", 0.0
					]
				}
			},

			{
				"box" : {
					"id" : "obj-reset-label",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 800.0, 120.0, 130.0, 16.0 ],
					"text" : "Reset",
					"fontface" : 1
				}
			},

			{
				"box" : {
					"id" : "obj-reset-btn",
					"maxclass" : "button",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "bang" ],
					"patching_rect" : [ 800.0, 138.0, 125.0, 36.0 ],
					"style" : "rounded"
				}
			},

			{
				"box" : {
					"id" : "obj-history-label",
					"maxclass" : "comment",
					"numinlets" : 1,
					"numoutlets" : 0,
					"patching_rect" : [ 15.0, 186.0, 200.0, 16.0 ],
					"text" : "Note history (last 12)",
					"fontface" : 1
				}
			},

			{
				"box" : {
					"id" : "obj-history-display",
					"maxclass" : "message",
					"numinlets" : 2,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 15.0, 204.0, 910.0, 22.0 ],
					"fontsize" : 12.0,
					"text" : ""
				}
			},

			{
				"box" : {
					"id" : "obj-sel0",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 2,
					"outlettype" : [ "bang", "" ],
					"patching_rect" : [ 15.0, 260.0, 50.0, 22.0 ],
					"text" : "sel 0"
				}
			},

			{
				"box" : {
					"id" : "obj-msg-zero",
					"maxclass" : "message",
					"numinlets" : 2,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 75.0, 260.0, 40.0, 22.0 ],
					"text" : "0"
				}
			},

			{
				"box" : {
					"id" : "obj-mtoname",
					"maxclass" : "newobj",
					"numinlets" : 1,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 130.0, 260.0, 75.0, 22.0 ],
					"text" : "mtoname"
				}
			},

			{
				"box" : {
					"id" : "obj-zlqueue",
					"maxclass" : "newobj",
					"numinlets" : 2,
					"numoutlets" : 2,
					"outlettype" : [ "", "int" ],
					"patching_rect" : [ 215.0, 260.0, 95.0, 22.0 ],
					"text" : "zl queue 12"
				}
			},

			{
				"box" : {
					"id" : "obj-prepend-set",
					"maxclass" : "newobj",
					"numinlets" : 2,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 320.0, 260.0, 85.0, 22.0 ],
					"text" : "prepend set"
				}
			},

			{
				"box" : {
					"id" : "obj-msg-reset-note",
					"maxclass" : "message",
					"numinlets" : 2,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 750.0, 260.0, 70.0, 22.0 ],
					"text" : "set \u2014"
				}
			},

			{
				"box" : {
					"id" : "obj-msg-reset-hist",
					"maxclass" : "message",
					"numinlets" : 2,
					"numoutlets" : 1,
					"outlettype" : [ "" ],
					"patching_rect" : [ 830.0, 260.0, 50.0, 22.0 ],
					"text" : "set"
				}
			}

		],
		"lines" : [

			{ "patchline" : { "source" : [ "obj-notein", 0 ], "destination" : [ "obj-kslider", 0 ] } },
			{ "patchline" : { "source" : [ "obj-notein", 0 ], "destination" : [ "obj-midi-num", 0 ] } },
			{ "patchline" : { "source" : [ "obj-notein", 0 ], "destination" : [ "obj-mtoname", 0 ] } },
			{ "patchline" : { "source" : [ "obj-notein", 1 ], "destination" : [ "obj-vel-num", 0 ] } },
			{ "patchline" : { "source" : [ "obj-notein", 1 ], "destination" : [ "obj-sel0", 0 ] } },

			{ "patchline" : { "source" : [ "obj-sel0", 0 ], "destination" : [ "obj-msg-zero", 0 ] } },
			{ "patchline" : { "source" : [ "obj-msg-zero", 0 ], "destination" : [ "obj-kslider", 0 ] } },

			{ "patchline" : { "source" : [ "obj-mtoname", 0 ], "destination" : [ "obj-note-display", 0 ] } },
			{ "patchline" : { "source" : [ "obj-mtoname", 0 ], "destination" : [ "obj-zlqueue", 0 ] } },

			{ "patchline" : { "source" : [ "obj-zlqueue", 0 ], "destination" : [ "obj-prepend-set", 0 ] } },
			{ "patchline" : { "source" : [ "obj-prepend-set", 0 ], "destination" : [ "obj-history-display", 0 ] } },

			{ "patchline" : { "source" : [ "obj-reset-btn", 0 ], "destination" : [ "obj-msg-zero", 0 ] } },
			{ "patchline" : { "source" : [ "obj-reset-btn", 0 ], "destination" : [ "obj-msg-reset-note", 0 ] } },
			{ "patchline" : { "source" : [ "obj-reset-btn", 0 ], "destination" : [ "obj-msg-reset-hist", 0 ] } },

			{ "patchline" : { "source" : [ "obj-msg-reset-note", 0 ], "destination" : [ "obj-note-display", 0 ] } },
			{ "patchline" : { "source" : [ "obj-msg-reset-hist", 0 ], "destination" : [ "obj-history-display", 0 ] } }

		]
	}
}
