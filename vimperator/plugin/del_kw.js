/*
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
*/
bookmarks.getSearchURL = function(text, useDefsearch) {
  let url = null;
  let postData = {};
  let searchString =
      (useDefsearch ? options["defsearch"] + " " : "")
      + text;

  this.getSearchEngines();

  url = window.getShortcutOrURI(searchString, postData);

  if (url == searchString)
    return null;

  if (postData && postData.value)
    return [url, postData.value];

  return [url, null]; // can be null
}

