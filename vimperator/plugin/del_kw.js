
if (!PlacesUtils.getURLAndPostDataForKeyword_orig)
    PlacesUtils.getURLAndPostDataForKeyword_orig = PlacesUtils.getURLAndPostDataForKeyword;

PlacesUtils.getURLAndPostDataForKeyword = function(aKeyword) { 
    try
    {
        bookmark = Components.classes["@yahoo.com/nsYDelLocalStore;1"].getService().getBookmarkFromShortcutURL(aKeyword);
        liberator.echo(bookmark.url);
        return [bookmark.url, null];
    }
    catch (e)
    {
        return PlacesUtils.getURLAndPostDataForKeyword_orig(aKeyword);
    }
};

