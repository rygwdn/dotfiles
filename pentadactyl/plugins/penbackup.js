"use strict";
var INFO
var INFO =
["plugin", { name: "penbackup",  version:"0.1",
        summary:"Backup Firefox info",
        xmlns:"dactyl"},
    ["author", {email: "rygwdn@gmail.com"}, "Ryan Wooden"],
    ["license", {href: "http://opensource.org/licenses/mit-license.php"}, "MIT"],
    ["project", {name: "Pentadactyl", "min-version": "1.0"}],
    ["p", {}, "Allows the ability to backup Firefox data."]
];

function savetabs(outfile){
    let defItem = { parent: { getTitle: function () "" } };
    let tabGroups = {};
    tabs.getGroups();

    let out = []

        tabs.allTabs.forEach(function (tab, i) {
            let group = (tab.tabItem || tab._tabViewTabItem || defItem).parent || defItem.parent;
            if (!set.has(tabGroups, group.id))
            tabGroups[group.id] = [group.getTitle(), []];
            group = tabGroups[group.id];
            group[1].push([i, tab.linkedBrowser]);
        });

    for (let [id, [name, vals]] in Iterator(tabGroups)) {
        id = id || 0;
        name = name || "default";

        //dactyl.echomsg(name);
        out.push(name);

        for (let [ii, [tabid, browser]] in Iterator(vals)) {
            var tab = tabs.getTab(tabid);
            var url = browser.contentDocument.location.href;
            var label = tab.label;

            //dactyl.echomsg("\ttitle:" + label + "\n\turl:" + url);
            out.push("\ttitle:" + label + "\n\turl:" + url);
        };
    };

    File(outfile).write(out.join("\n"));
};

function saveaddons(outfile) {
    AddonManager.getAllAddons(function(addons){
        let out = []
        addons.forEach(function(addon, i){
            let mes = (
                "id: " + addon.id + 
                "\n\tname: " + addon.name +
                "\n\tversion: " + addon.version + 
                "\n\ttype: " + addon.type +
                "\n\tenabled: " + !(addon.appDisabled || addon.userDisabled) +
                "\n\n"
                );
            //dactyl.echomsg(mes);
            out.push(mes);
        });
        File(outfile).write(out.join("\n"));
    });
};

// vim: sw=4
