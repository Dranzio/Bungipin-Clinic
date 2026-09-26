// to check if request body is empty
// first and maybe only use is for forgot + reset pass in userController
exports.isEmpty = function (obj) {
    for(var prop in obj) {
        if(obj.hasOwnProperty(prop))
            return false;
    }
    return JSON.stringify(obj) === JSON.stringify({});
}